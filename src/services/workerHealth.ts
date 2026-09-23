import { WorkerStatus } from '@temporalio/worker'
import { PollerState } from '@temporalio/worker/lib/worker.js'

import { HealthCheckResult, HttpStatusCode, OnHealthCheck } from '@diia-inhouse/types'

import { WorkerStatusProvider } from '../interfaces/services/worker.js'

export interface WorkerHealthDetails {
    worker: WorkerStatus | 'NOT_INITIALIZED'
}

function isPollerHealthy(state: PollerState): boolean {
    return state === 'POLLING'
}

function isWorkerHealthy(status: WorkerStatus, hasActivities: boolean): boolean {
    const { runState, workflowPollerState, activityPollerState } = status

    if (runState !== 'RUNNING') {
        return false
    }

    if (!isPollerHealthy(workflowPollerState)) {
        return false
    }

    return !hasActivities || isPollerHealthy(activityPollerState)
}

export class WorkerHealthService implements OnHealthCheck {
    private statusProvider?: WorkerStatusProvider

    constructor(private readonly hasActivities = true) {}

    setStatusProvider(provider: WorkerStatusProvider): void {
        this.statusProvider = provider
    }

    async onHealthCheck(): Promise<HealthCheckResult<WorkerHealthDetails>> {
        if (!this.statusProvider) {
            return {
                status: HttpStatusCode.SERVICE_UNAVAILABLE,
                details: { worker: 'NOT_INITIALIZED' },
            }
        }

        const workerStatus = this.statusProvider()
        const isHealthy = isWorkerHealthy(workerStatus, this.hasActivities)

        return {
            status: isHealthy ? HttpStatusCode.OK : HttpStatusCode.SERVICE_UNAVAILABLE,
            details: { worker: workerStatus },
        }
    }
}
