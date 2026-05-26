/* oxlint-disable typescript/no-explicit-any */
import { WorkerOptions, WorkerStatus } from '@temporalio/worker'

/**
 * Structural type for the OpenTelemetry tracer provider that pkg-workflow accepts.
 *
 * pkg-workflow only needs the `service.name` resource attribute. By matching that
 * shape structurally (instead of importing `NodeTracerProvider` from a pinned
 * `@opentelemetry/sdk-trace-node` major), we accept providers from both OTel 1.x
 * (where `resource` is a public field) and OTel 2.x (where it is private and the
 * value is read defensively at runtime).
 *
 * `getTracer` is required because it is the only public member shared by both
 * OTel majors — without it TypeScript's weak-type check rejects 2.x providers
 * (whose other state is private).
 */
export interface NodeTracerProviderLike {
    getTracer(name: string, version?: string, options?: { schemaUrl?: string }): unknown
    resource?: { attributes?: Record<string, unknown> }
}

export type { State, WorkerStatus } from '@temporalio/worker'

export type WorkerStatusProvider = () => WorkerStatus

export type ActivityInstance = Record<string, (...args: any[]) => any>

export type BoundActivities<T extends ActivityInstance> = {
    [K in keyof T as `${string}.${string & K}`]: ReturnType<T[K]> extends Promise<any>
        ? T[K]
        : (...args: Parameters<T[K]>) => Promise<ReturnType<T[K]>>
}

export type ActivityClass = new (...args: any[]) => any

export interface WorkerBootstrapOptions extends Omit<WorkerOptions, 'taskQueue' | 'activities' | 'workflowsPath'> {
    /**
     * Path to the workflows module. Accepts either an absolute filesystem path
     * or a `file://` URL (e.g. from `import.meta.resolve('./worker/workflows/index.js')`).
     */
    workflowsPath: string
    activities: Record<string, ActivityClass>
    nodeTracerProvider?: NodeTracerProviderLike
    shutdownSignals?: NodeJS.Signals[]
    /**
     * When provided together with `deps`, `bootstrapWorker` manages the full application
     * lifecycle: setConfig → apply worker overrides → setDeps → initialize → start → run worker.
     */
    configFactory?: (...args: any[]) => Promise<any>
    /**
     * Dependency factory passed to `app.setDeps()`. Required when `configFactory` is provided.
     */
    deps?: (...args: any[]) => Promise<any>
}

interface Container {
    build(constructor: new (...args: unknown[]) => unknown): unknown
    resolve<T = unknown>(key: string): T
}

export interface App {
    container?: Container
    getConfig?(): unknown
    setConfig?(factory: (...args: any[]) => Promise<any>): Promise<any>
    setDeps?(factory: (...args: any[]) => Promise<any>): Promise<any>
    initialize?(...args: any[]): Promise<{ start(): Promise<any> }>
}
