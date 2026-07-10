import { AsyncLocalStorage } from 'node:async_hooks'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Resource } from '@opentelemetry/resources'
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions'
import { Context as ActivityContext } from '@temporalio/activity'
import {
    OpenTelemetryActivityInboundInterceptor,
    OpenTelemetryActivityOutboundInterceptor,
    makeWorkflowExporter,
} from '@temporalio/interceptors-opentelemetry/lib/worker/index.js'
import {
    ActivityInterceptors,
    NativeConnection,
    Runtime,
    RuntimeOptions,
    Worker,
    WorkerInterceptors,
    WorkerOptions,
} from '@temporalio/worker'

import { QueueConnectionType } from '@diia-inhouse/diia-queue'
import { EnvService } from '@diia-inhouse/env'
import { HealthCheck } from '@diia-inhouse/healthcheck'
import { AlsData, Logger } from '@diia-inhouse/types'

import { getDataConverter } from '../encryption/index.js'
import { traceExporter } from '../instrumentation.js'
import { AsyncLocalStorageBridgeInterceptor } from '../interceptors/asyncLocalStorageBridge.js'
import { AppConfig } from '../interfaces/config.js'
import type {
    ActivityClass,
    ActivityInstance,
    App,
    BoundActivities,
    NodeTracerProviderLike,
    RunInProcessWorkerOptions,
    RunStandaloneWorkerOptions,
    WorkerBootstrapOptions,
    WorkerRunOptions,
} from '../interfaces/services/worker.js'
import { buildWorkerIdentity } from './worker/identity.js'
import { deriveWorkflowTypes, registerWorkerInfo } from './worker/info.js'
import { WorkerHealthService } from './workerHealth.js'

export type {
    ActivityClass,
    App,
    RunInProcessWorkerOptions,
    RunStandaloneWorkerOptions,
    State,
    WorkerBootstrapOptions,
    WorkerRunOptions,
} from '../interfaces/services/worker.js'

export type { WorkerHealthDetails } from './workerHealth.js'

export { buildWorkerIdentity } from './worker/identity.js'

export { WorkerHealthService } from './workerHealth.js'

/**
 * Applies service process configuration overrides when the worker runs separately.
 *
 * When `temporal.workerInProcess` is `false`, disables `temporal` and `temporal-worker` scrapers
 * so the main service does not scrape metrics that the worker process handles.
 *
 * Mutates the config object in place. Safe to call when scrapers are absent.
 */
export function applyServiceProcessConfig(config: AppConfig): void {
    const { workerInProcess = true } = config.temporal
    if (workerInProcess) {
        return
    }

    for (const scraper of config.metrics.custom.scrapers ?? []) {
        if (scraper.name === 'temporal' || scraper.name === 'temporal-worker') {
            scraper.disabled = true
        }
    }
}

/**
 * Applies worker process configuration overrides.
 *
 * - Disables queue consumers on the internal and external rabbit connections (unless `temporal.disableQueueConsumers` is `false`)
 * - Overrides `metrics.custom.port` with the `'temporal-worker'` scraper port and disables that scraper to prevent self-scraping
 *
 * Mutates the config object in place. Safe to call when queue config is absent.
 */
export function applyWorkerProcessConfig(config: AppConfig): void {
    const { disableQueueConsumers = true } = config.temporal

    if (disableQueueConsumers && config.rabbit) {
        for (const connectionType of [QueueConnectionType.Internal, QueueConnectionType.External]) {
            const connectionConfig = config.rabbit[connectionType]
            if (connectionConfig) {
                connectionConfig.consumerEnabled = false
            }
        }
    }

    const workerScraper = config.metrics.custom.scrapers?.find((s) => s.name === 'temporal-worker')
    if (workerScraper?.port !== undefined) {
        config.metrics.custom.port = workerScraper.port
        workerScraper.disabled = true
    }
}

/**
 * Accepts either a filesystem path or a `file://` URL (e.g. from `import.meta.resolve`)
 * and returns a filesystem path suitable for Temporal's worker.
 */
export function toWorkflowsPath(input: string): string {
    return input.startsWith('file://') ? fileURLToPath(input) : input
}

/**
 * Builds worker interceptors with OpenTelemetry and AsyncLocalStorage support.
 * OpenTelemetry creates span first, then AsyncLocalStorage bridge extracts traceId.
 */
const traceLogAttributesModulePath = path.resolve(import.meta.dirname, '../interceptors/traceLogAttributes')

function buildWorkerInterceptors(
    tracingEnabled: boolean,
    asyncLocalStorage: AsyncLocalStorage<AlsData> | undefined,
    logger: Logger | undefined,
    workflowsPath: string | undefined,
): WorkerInterceptors | undefined {
    if (tracingEnabled) {
        const workflowModules = [traceLogAttributesModulePath]

        if (workflowsPath) {
            workflowModules.unshift(workflowsPath)
        }

        return {
            activity: [
                (ctx: ActivityContext): ActivityInterceptors => ({
                    inbound: new OpenTelemetryActivityInboundInterceptor(ctx),
                    outbound: new OpenTelemetryActivityOutboundInterceptor(ctx),
                }),
                ...(asyncLocalStorage && logger
                    ? [
                          (ctx: ActivityContext): ActivityInterceptors => ({
                              inbound: new AsyncLocalStorageBridgeInterceptor(ctx, asyncLocalStorage, logger),
                          }),
                      ]
                    : []),
            ],
            workflowModules,
        }
    }

    if (asyncLocalStorage && logger) {
        return {
            activity: [
                (ctx: ActivityContext): ActivityInterceptors => ({
                    inbound: new AsyncLocalStorageBridgeInterceptor(ctx, asyncLocalStorage, logger),
                    outbound: new OpenTelemetryActivityOutboundInterceptor(ctx),
                }),
            ],
            workflowModules: workflowsPath ? [workflowsPath] : [],
        }
    }

    return undefined
}

/**
 * Merges built-in interceptors with custom interceptors from options.
 */
function mergeInterceptors(
    builtIn: WorkerInterceptors | undefined,
    custom: WorkerInterceptors | undefined,
): WorkerInterceptors | undefined {
    if (!builtIn && !custom) {
        return undefined
    }

    return {
        activity: [...(builtIn?.activity || []), ...(custom?.activity || [])],
        workflowModules: [...(builtIn?.workflowModules || []), ...(custom?.workflowModules || [])],
    }
}

function buildActivities(app: App, activities: Record<string, unknown>): Record<string, ActivityInstance> {
    const instances: Record<string, ActivityInstance> = {}
    for (const [key, value] of Object.entries(activities)) {
        instances[key] = app.container!.build(value as new (...args: unknown[]) => unknown) as ActivityInstance
    }

    return instances
}

function bindActivities<T extends ActivityInstance>(key: string, instance: T): BoundActivities<T> {
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(instance)).filter((name) => name !== 'constructor') as (keyof T)[]

    const boundActivities = {} as BoundActivities<T>
    for (const method of methods) {
        const fn = instance[method]
        const token = `${key}.${String(method)}` as keyof BoundActivities<T>

        boundActivities[token] = fn.bind(instance) as BoundActivities<T>[keyof BoundActivities<T>]
    }

    return boundActivities
}

export function instantiateActivities(
    app: App,
    workerActivities: Record<string, ActivityClass>,
): Record<string, (...args: unknown[]) => Promise<unknown>> {
    const activitiesInstances = buildActivities(app, workerActivities)

    const activities: Record<string, (...args: unknown[]) => Promise<unknown>> = {}

    for (const [key, value] of Object.entries(activitiesInstances)) {
        Object.assign(activities, bindActivities(key, value))
    }

    return activities
}

/**
 * Runs the Temporal worker in the **dedicated worker process**.
 *
 * This entry point owns the full application lifecycle — it is meant to be the only
 * call in a standalone worker entry file (e.g. `workerEntry.ts`):
 *
 *   setConfig → apply worker overrides → setDeps → initialize → start → run worker
 *
 * A worker process always runs a worker, so `workerInProcess` is not consulted here.
 * Applies the worker-process config overrides (disables queue consumers, moves metrics
 * to the `temporal-worker` scraper port) before the app starts, and integrates worker
 * health with the app's centralized health check.
 *
 * @param app - App instance (config is set here, so it must be un-initialized)
 * @param options - Worker process options; `configFactory` and `deps` are required
 *
 * @example
 * ```typescript
 * // workerEntry.ts — the standalone worker process
 * const app = new Application(serviceName, nodeTracerProvider, loggerConfig)
 *
 * await runStandaloneWorker(app, {
 *     configFactory,
 *     deps,
 *     workflowsPath: import.meta.resolve('./worker/workflows/index.js'),
 *     activities: workerActivities,
 *     nodeTracerProvider,
 * })
 * ```
 */
export async function runStandaloneWorker(app: App, options: RunStandaloneWorkerOptions): Promise<void> {
    const { configFactory, deps, ...runOptions } = options

    await app.setConfig!(configFactory)

    applyWorkerProcessConfig(app.getConfig!() as AppConfig)

    await app.setDeps!(deps)
    const appOperator = await app.initialize!()

    await appOperator.start()

    await runWorker(app, runOptions)
}

/**
 * Runs the Temporal worker **in the main service process**, alongside an app that the
 * caller has already initialized and started.
 *
 * Behaviour is driven solely by `temporal.workerInProcess`:
 *
 * - not `false` (default): builds and runs the worker in this process (blocks until shutdown).
 * - `false`: the worker runs elsewhere (see {@link runStandaloneWorker}); disables the temporal
 *   scrapers on this service and returns immediately.
 *
 * Call it after `initialized.start()`.
 *
 * @param app - App instance for DI container and config access
 * @param options - In-process worker options
 *
 * @example
 * ```typescript
 * // bootstrap.ts — the main service process
 * await app.setConfig(configFactory)
 * await app.setDeps(deps)
 * const initialized = await app.initialize()
 * await initialized.start()
 *
 * await runInProcessWorker(app, {
 *     workflowsPath: import.meta.resolve('./worker/workflows/index.js'),
 *     activities: workerActivities,
 *     nodeTracerProvider,
 * })
 * ```
 */
export async function runInProcessWorker(app: App, options: RunInProcessWorkerOptions): Promise<void> {
    const config = app.getConfig?.() as AppConfig

    if (config.temporal.workerInProcess === false) {
        applyServiceProcessConfig(config)

        return
    }

    await runWorker(app, options)
}

/**
 * @deprecated Split into two role-specific entry points — migrate to one of:
 *
 * - {@link runStandaloneWorker} — the dedicated worker process (was `bootstrapWorker(app, { configFactory, deps, ... })`).
 * - {@link runInProcessWorker} — the worker running inside the already-started main service
 *   (was `bootstrapWorker(app, { ... })` without `configFactory`/`deps`).
 *
 * This shim just forwards to those based on whether `configFactory` and `deps` are present, so
 * existing call sites keep working. It multiplexes both roles by inspecting which options were
 * passed — the exact ambiguity the split removes — and will be dropped in a future major.
 *
 * @param app - App instance for DI container and config access
 * @param options - Legacy worker bootstrap options
 */
export async function bootstrapWorker(app: App, options: WorkerBootstrapOptions): Promise<void> {
    const { configFactory, deps, ...runOptions } = options

    if (configFactory && deps) {
        await runStandaloneWorker(app, { ...runOptions, configFactory, deps })

        return
    }

    await runInProcessWorker(app, runOptions)
}

/**
 * Shared worker startup used by both {@link runStandaloneWorker} and {@link runInProcessWorker}.
 *
 * Assumes the app is already initialized and started. Instantiates activities from the DI
 * container, creates the worker, registers its health check, installs graceful-shutdown
 * signal handlers, and runs it until shutdown.
 */
async function runWorker(app: App, options: WorkerRunOptions): Promise<void> {
    const {
        workflowsPath: workflowsPathInput,
        activities,
        nodeTracerProvider,
        shutdownSignals = ['SIGTERM', 'SIGINT'],
        ...workerOptions
    } = options
    const workflowsPath = toWorkflowsPath(workflowsPathInput)

    const config = app.getConfig?.() as AppConfig

    const envService = app.container!.resolve<EnvService>('envService')
    const logger = app.container!.resolve<Logger>('logger')
    const asyncLocalStorage = app.container!.resolve<AsyncLocalStorage<AlsData>>('asyncLocalStorage')

    const taskQueue = config.temporal.taskQueue
    const identity = buildWorkerIdentity(taskQueue, workerOptions.identity)

    const instantiatedActivities = instantiateActivities(app, activities)

    const worker = await initWorker(
        config,
        {
            ...workerOptions,
            workflowsPath,
            activities: instantiatedActivities,
            identity,
        },
        envService,
        logger,
        nodeTracerProvider,
        asyncLocalStorage,
    )

    logger.info('Starting Temporal worker', { taskQueue, identity })

    const healthCheck = tryResolve<HealthCheck>(app.container!, 'healthCheck')
    if (healthCheck) {
        const workerHealthService = new WorkerHealthService()

        workerHealthService.setStatusProvider(() => worker.getStatus())
        healthCheck.addHealthCheckable(workerHealthService)
    }

    const signalHandler = (): void => {
        worker.shutdown()
    }

    for (const signal of shutdownSignals) {
        process.once(signal, signalHandler)
    }

    try {
        await worker.run()
    } finally {
        for (const signal of shutdownSignals) {
            process.off(signal, signalHandler)
        }
    }
}

function tryResolve<T>(container: NonNullable<App['container']>, key: string): T | undefined {
    try {
        return container.resolve<T>(key)
    } catch {
        return undefined
    }
}

/**
 * Initializes Temporal worker.
 *
 * @param config - Application configuration
 * @param options - Worker options including workflows path
 * @param envService - Environment service instance
 * @param logger - Logger instance (optional)
 * @param nodeTracerProvider - OpenTelemetry tracer provider (optional)
 * @param asyncLocalStorage - AsyncLocalStorage instance for tracing context (optional)
 * @returns Configured Temporal worker
 */
export async function initWorker(
    { temporal: temporalConfig, metrics: { custom: metricsConfig } }: AppConfig,
    options: Omit<WorkerOptions, 'taskQueue'> & {
        taskQueue?: string
        /** The workflows this worker runs. Auto-detected from the workflows folder when left empty. */
        workflowTypes?: string[]
        /** Service name. Defaults to the name derived from the task queue. */
        service?: string
    },
    envService: EnvService,
    logger?: Logger,
    nodeTracerProvider?: NodeTracerProviderLike,
    asyncLocalStorage?: AsyncLocalStorage<AlsData>,
): Promise<Worker> {
    const { encryptionEnabled, encryptionKeyId, encryptionKeyRefreshInterval, namespace = 'default', address, taskQueue } = temporalConfig

    const runtimeParams: RuntimeOptions = {}
    if (logger) {
        runtimeParams.logger = logger.child({ taskQueue })
    }

    const temporalMetrics = metricsConfig.scrapers?.find((s) => s.name === 'temporal')
    if (temporalMetrics && !temporalMetrics.disabled) {
        runtimeParams.telemetryOptions = {
            metrics: {
                prometheus: {
                    bindAddress: `0.0.0.0:${temporalMetrics.port}`,
                    useSecondsForDurations: true,
                    countersTotalSuffix: true,
                    unitSuffix: true,
                },
            },
        }
    }

    Runtime.install(runtimeParams)

    // OTel 1.x exposes `resource` publicly; 2.x renamed it to `_resource` (private).
    // Read both shapes so the worker accepts a NodeTracerProvider from either major.
    const providerWithPrivateResource = nodeTracerProvider as
        | (NodeTracerProviderLike & Record<'_resource', { attributes?: Record<string, unknown> } | undefined>)
        | undefined
    const tracerResource = nodeTracerProvider?.resource ?? providerWithPrivateResource?.['_resource']
    const resource = new Resource({
        [ATTR_SERVICE_NAME]: tracerResource?.attributes?.[ATTR_SERVICE_NAME] as string | undefined,
    })

    const tracingEnabled = EnvService.getVar('TRACING_ENABLED', 'boolean', false)

    const workflowsPath = options.workflowsPath ? toWorkflowsPath(options.workflowsPath) : undefined
    const builtInInterceptors = buildWorkerInterceptors(tracingEnabled, asyncLocalStorage, logger, workflowsPath)
    const mergedInterceptors = mergeInterceptors(builtInInterceptors, options.interceptors)

    const { workflowTypes, service: serviceOverride, ...workerCreateOptions } = options

    try {
        const worker = await Worker.create({
            namespace,
            taskQueue,
            connection: await NativeConnection.connect({ address }),
            dataConverter: encryptionEnabled
                ? await getDataConverter(encryptionKeyId, envService, encryptionKeyRefreshInterval)
                : undefined,
            ...workerCreateOptions,
            workflowsPath,
            sinks: tracingEnabled ? { exporter: makeWorkflowExporter(traceExporter, resource) } : undefined,
            interceptors: mergedInterceptors,
        })

        if (taskQueue) {
            try {
                const resolvedWorkflowTypes =
                    workflowTypes ?? (workflowsPath ? await deriveWorkflowTypes(workflowsPath, logger) : undefined)

                registerWorkerInfo({ namespace, taskQueue, service: serviceOverride, workflowTypes: resolvedWorkflowTypes })
            } catch (err) {
                logger?.warn('Failed to record diia_temporal_worker_info metric', { err })
            }
        }

        return worker
    } catch (err) {
        logger?.error('Failed to create Temporal worker', { err })

        throw new Error('Failed to create Temporal worker', { cause: err })
    }
}
