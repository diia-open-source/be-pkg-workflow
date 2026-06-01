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
    WorkerBootstrapOptions,
} from '../interfaces/services/worker.js'
import { buildWorkerIdentity } from './worker/identity.js'
import { WorkerHealthService } from './workerHealth.js'

export type { ActivityClass, App, State, WorkerBootstrapOptions } from '../interfaces/services/worker.js'

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
 * - Disables queue consumers on all rabbit connections (unless `temporal.disableQueueConsumers` is `false`)
 * - Overrides `metrics.custom.port` with the `'temporal-worker'` scraper port and disables that scraper to prevent self-scraping
 *
 * Mutates the config object in place. Safe to call when queue config is absent.
 */
export function applyWorkerProcessConfig(config: AppConfig): void {
    const { disableQueueConsumers = true } = config.temporal

    if (disableQueueConsumers && config.rabbit) {
        for (const value of Object.values(config.rabbit)) {
            if (value && typeof value === 'object' && 'consumerEnabled' in value) {
                value.consumerEnabled = false
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
 * Initializes and starts Temporal worker with full dependency injection support.
 *
 * This is the recommended way to initialize Temporal workers. It handles:
 * - Automatic dependency injection for activities
 * - AsyncLocalStorage setup for distributed tracing
 * - OpenTelemetry integration
 * - Activity instantiation and binding
 *
 * @param app - App instance for DI container and config access
 * @param options - Worker configuration options
 * @param options.nodeTracerProvider - OpenTelemetry tracer provider
 * @param options.workflowsPath - Path to workflows module
 * @param options.activities - Activity classes to instantiate
 *
 * @example
 * ```typescript
 * // Define your activities
 * const workerActivities = {
 *     userActivity: UserActivity,
 *     notificationActivity: NotificationActivity,
 * }
 *
 * // Initialize and start the worker
 * await initTemporalWorker(app, {
 *     nodeTracerProvider,
 *     workflowsPath: import.meta.resolve('./worker/workflows/index.js'),
 *     activities: workerActivities,
 * })
 * ```
 */
export async function initTemporalWorker(
    app: App,
    options: {
        nodeTracerProvider: NodeTracerProviderLike
        workflowsPath: string
        activities: Record<string, ActivityClass>
    } & Omit<WorkerOptions, 'taskQueue' | 'activities' | 'workflowsPath'>,
): Promise<void> {
    const config = app.getConfig?.() as AppConfig
    const { nodeTracerProvider, workflowsPath: workflowsPathInput, activities, ...workerOptions } = options
    const workflowsPath = toWorkflowsPath(workflowsPathInput)

    const envService = app.container!.resolve<EnvService>('envService')
    const logger = app.container!.resolve<Logger>('logger')
    const asyncLocalStorage = app.container!.resolve<AsyncLocalStorage<AlsData>>('asyncLocalStorage')

    const instantiatedActivities = instantiateActivities(app, activities)

    const worker = await initWorker(
        config,
        { ...workerOptions, workflowsPath, activities: instantiatedActivities },
        envService,
        logger,
        nodeTracerProvider,
        asyncLocalStorage,
    )

    await worker.run()
}

/**
 * Bootstraps and runs Temporal worker with graceful shutdown.
 *
 * Handles both in-process and separate-process worker topologies:
 *
 * - **In-process** (`workerInProcess` is `true` or unset): initializes and runs the worker.
 * - **Separate process** (called from a dedicated worker entry with `configFactory`/`deps`):
 *   manages the full application lifecycle: setConfig → apply worker overrides → setDeps →
 *   initialize → start → run worker.
 * - **Service-only** (`workerInProcess` is `false`, no `configFactory`): disables temporal
 *   scrapers on the main service (worker handles them separately) and returns immediately.
 *
 * Automatically integrates worker health with the app's centralized health check
 * system via `HealthCheck.addHealthCheckable()`.
 *
 * @param app - App instance for DI container and config access
 * @param options - Worker bootstrap options
 *
 * @example
 * ```typescript
 * // Separate worker process with full lifecycle management
 * const app = new Application(serviceName, nodeTracerProvider, loggerConfig)
 *
 * await bootstrapWorker(app, {
 *     configFactory,
 *     deps,
 *     workflowsPath: import.meta.resolve('./worker/workflows/index.js'),
 *     activities: workerActivities,
 *     nodeTracerProvider,
 * })
 * ```
 */
export async function bootstrapWorker(app: App, options: WorkerBootstrapOptions): Promise<void> {
    const {
        configFactory,
        deps,
        workflowsPath: workflowsPathInput,
        activities,
        nodeTracerProvider,
        shutdownSignals = ['SIGTERM', 'SIGINT'],
        ...workerOptions
    } = options
    const workflowsPath = toWorkflowsPath(workflowsPathInput)

    if (configFactory && deps) {
        await app.setConfig!(configFactory)

        applyWorkerProcessConfig(app.getConfig!() as AppConfig)

        await app.setDeps!(deps)
        const appOperator = await app.initialize!()

        await appOperator.start()
    }

    const config = app.getConfig?.() as AppConfig

    if (!configFactory && config.temporal.workerInProcess === false) {
        applyServiceProcessConfig(config)

        return
    }

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
    options: Omit<WorkerOptions, 'taskQueue'> & { taskQueue?: string },
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

    try {
        const worker = await Worker.create({
            namespace,
            taskQueue,
            connection: await NativeConnection.connect({ address }),
            dataConverter: encryptionEnabled
                ? await getDataConverter(encryptionKeyId, envService, encryptionKeyRefreshInterval)
                : undefined,
            ...options,
            workflowsPath,
            sinks: tracingEnabled ? { exporter: makeWorkflowExporter(traceExporter, resource) } : undefined,
            interceptors: mergedInterceptors,
        })

        return worker
    } catch (err) {
        logger?.error('Failed to create Temporal worker', { err })

        throw new Error('Failed to create Temporal worker', { cause: err })
    }
}
