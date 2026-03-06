import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import { WorkerOptions, WorkerStatus } from '@temporalio/worker'

export type { State, WorkerStatus } from '@temporalio/worker'

export type WorkerStatusProvider = () => WorkerStatus

/* eslint-disable @typescript-eslint/no-explicit-any */
export type ActivityInstance = Record<string, (...args: any[]) => any>

export type BoundActivities<T extends ActivityInstance> = {
    [K in keyof T as `${string}.${string & K}`]: ReturnType<T[K]> extends Promise<any>
        ? T[K]
        : (...args: Parameters<T[K]>) => Promise<ReturnType<T[K]>>
}

// eslint-enable @typescript-eslint/no-explicit-any
export type ActivityClass = new (...args: any[]) => any

export interface WorkerBootstrapOptions extends Omit<WorkerOptions, 'taskQueue' | 'activities' | 'workflowsPath'> {
    workflowsPath: string
    activities: Record<string, ActivityClass>
    nodeTracerProvider?: NodeTracerProvider
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
