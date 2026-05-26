import { ClientOptions, ConnectionOptions } from '@temporalio/client'

import { MetricsConfig } from '@diia-inhouse/diia-metrics'
import type { QueueConnectionConfig } from '@diia-inhouse/diia-queue'

import type { SchedulesExporterConfig } from './services/schedulesExporter.js'

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
    /**
     * Controls the SchedulesExporter, which polls Temporal Schedule and Visibility APIs and
     * emits per-schedule + in-flight workflow gauges (`diia_schedule_*`, `diia_workflows_running`,
     * etc.). Auto-started by `bootstrapWorker` / `initTemporalWorker` — services do not need
     * to instantiate it themselves.
     *
     * Runs only in the worker process: when `workerInProcess === false` and the service is
     * started without `bootstrapWorker`'s lifecycle path, the exporter is skipped (the worker
     * process owns it).
     *
     * - Omit (default) — exporter starts with the defaults in `SchedulesExporterConfig`.
     * - `false` — disable the exporter entirely (e.g. for clusters without advanced visibility).
     * - Object — override polling intervals or other knobs. See `SchedulesExporterConfig`.
     */
    schedulesExporter?: SchedulesExporterConfig | false
}

export interface AppConfig {
    temporal: TemporalConfig
    metrics: { custom: MetricsConfig }
    rabbit?: QueueConnectionConfig
}
