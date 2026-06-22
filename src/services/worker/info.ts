import { pathToFileURL } from 'node:url'

import { Observer } from '@diia-inhouse/diia-metrics'

export const WORKER_INFO_METRIC = 'diia_temporal_worker_info'

export interface WorkerInfoLabels {
    namespace: string
    temporal_namespace: string
    task_queue: string
    service: string
    workflow_type: string
}

const WORKER_INFO_LABELS: (keyof WorkerInfoLabels)[] = ['namespace', 'temporal_namespace', 'task_queue', 'service', 'workflow_type']

export function taskQueueToService(taskQueue: string): string {
    const trimmed = taskQueue.trim()
    if (!trimmed) {
        return 'unknown'
    }

    return trimmed.replace(/[-_](worker|workers|queue)$/i, '')
}

export interface RegisterWorkerInfoParams {
    namespace: string
    taskQueue: string
    /** Service name. Defaults to the name derived from the task queue. */
    service?: string
    /** The workflows this worker runs (one entry each). Leave empty to record just the worker. */
    workflowTypes?: string[]
}

export function registerWorkerInfo({ namespace, taskQueue, service, workflowTypes }: RegisterWorkerInfoParams): void {
    if (!taskQueue) {
        return
    }

    const resolvedService = service?.trim() || taskQueueToService(taskQueue)

    const info = new Observer<WorkerInfoLabels>(
        WORKER_INFO_METRIC,
        WORKER_INFO_LABELS,
        'Which namespace, task queue and workflows a service runs (always 1).',
    )

    const base = { namespace, temporal_namespace: namespace, task_queue: taskQueue, service: resolvedService }
    const types = workflowTypes?.length ? workflowTypes : ['']

    for (const workflow_type of types) {
        info.observe({ ...base, workflow_type }, 1)
    }
}

export async function deriveWorkflowTypes(
    workflowsPath: string,
    logger?: { warn(message: string, meta?: unknown): void },
): Promise<string[] | undefined> {
    try {
        const mod: Record<string, unknown> = await import(pathToFileURL(workflowsPath).href)
        const types = Object.entries(mod)
            .filter(
                ([, value]) =>
                    typeof value === 'function' && (value as { constructor?: { name?: string } }).constructor?.name === 'AsyncFunction',
            )
            .map(([name]) => name)

        return types.length ? types : undefined
    } catch (err) {
        logger?.warn('worker-info: could not read workflows; recording the worker without per-workflow detail', { err })

        return undefined
    }
}
