import { ClientOptions, ConnectionOptions } from '@temporalio/client'

import { MetricsConfig } from '@diia-inhouse/diia-metrics'
import type { QueueConnectionConfig } from '@diia-inhouse/diia-queue'

export interface TemporalConfig extends Omit<ClientOptions, 'dataConverter'> {
    taskQueue: string
    encryptionEnabled: boolean
    encryptionKeyId: string
    encryptionKeyRefreshInterval?: number
    address?: string
    tls?: ConnectionOptions['tls']
    connectTimeout?: ConnectionOptions['connectTimeout']
    /**
     * Controls whether the Temporal worker runs in the same process as the service.
     *
     * - `true` (default): Worker is bootstrapped together with the service in the same process.
     * - `false`: Service starts without bootstrapping the worker. The worker should be run
     *   as a separate process using `bootstrapWorker()`.
     *
     * This is configured at the service level to enable flexible deployment topologies
     * where workers can be scaled independently from the main service.
     */
    workerInProcess?: boolean
    /**
     * Whether to disable message queue consumers when running as a separate worker process.
     * Applies to all queue connection types (internal, external, etc.).
     *
     * Defaults to `true` when `bootstrapWorker` manages the full application lifecycle
     * (i.e. when `configFactory` and `deps` are provided).
     */
    disableQueueConsumers?: boolean
}

export interface AppConfig {
    temporal: TemporalConfig
    metrics: { custom: MetricsConfig }
    rabbit?: QueueConnectionConfig
}
