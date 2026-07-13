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
     * gRPC channel arguments forwarded to the Temporal connection
     * (e.g. `'grpc.max_receive_message_length'`). Merged over the package defaults.
     */
    channelArgs?: ConnectionOptions['channelArgs']
    /**
     * Controls whether the Temporal worker runs in the same process as the service.
     *
     * - `true` (default): Worker is bootstrapped together with the service in the same process.
     * - `false`: Service starts without running the worker in-process. The worker should be run
     *   as a separate process using `runStandaloneWorker()`.
     *
     * This is configured at the service level to enable flexible deployment topologies
     * where workers can be scaled independently from the main service.
     */
    workerInProcess?: boolean
    /**
     * Whether to disable message queue consumers when running as a separate worker process.
     * Applies to all queue connection types (internal, external, etc.).
     *
     * Defaults to `true`. Applied by `runStandaloneWorker` (the dedicated worker process)
     * when it shapes config before starting the app.
     */
    disableQueueConsumers?: boolean
    /**
     * Whether a standalone worker should advertise no Moleculer actions. It stays a Moleculer client
     * (outbound `act()` still works), so inbound actions go only to the main service.
     *
     * Defaults to `true`. Applied by `runStandaloneWorker` via `applyWorkerProcessConfig`.
     */
    disableMoleculerActions?: boolean
}

export interface AppConfig {
    temporal: TemporalConfig
    metrics: { custom: MetricsConfig }
    rabbit?: QueueConnectionConfig
    /**
     * Set by `applyWorkerProcessConfig` for standalone workers; read by diia-app's
     * `MoleculerService.onInit` to register the node with no actions.
     */
    disableMoleculerActions?: boolean
}
