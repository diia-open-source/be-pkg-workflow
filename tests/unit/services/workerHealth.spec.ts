import { describe, expect, it } from 'vitest'

import { HttpStatusCode } from '@diia-inhouse/types'

import { WorkerStatus } from '../../../src/interfaces/services/worker'
import { WorkerHealthService } from '../../../src/services/workerHealth'

function createWorkerStatus(overrides: Partial<WorkerStatus> = {}): WorkerStatus {
    return {
        runState: 'RUNNING',
        workflowPollerState: 'POLLING',
        activityPollerState: 'POLLING',
        hasOutstandingWorkflowPoll: false,
        hasOutstandingActivityPoll: false,
        numInFlightWorkflowActivations: 0,
        numInFlightActivities: 0,
        numInFlightNonLocalActivities: 0,
        numInFlightLocalActivities: 0,
        numCachedWorkflows: 0,
        numHeartbeatingActivities: 0,
        ...overrides,
    }
}

describe('WorkerHealthService', () => {
    describe('onHealthCheck', () => {
        it('should return SERVICE_UNAVAILABLE when status provider is not set', async () => {
            const service = new WorkerHealthService()

            const result = await service.onHealthCheck()

            expect(result.status).toBe(HttpStatusCode.SERVICE_UNAVAILABLE)
            expect(result.details.worker).toBe('NOT_INITIALIZED')
        })

        it('should return OK when worker is healthy', async () => {
            const service = new WorkerHealthService()
            const status = createWorkerStatus()

            service.setStatusProvider(() => status)

            const result = await service.onHealthCheck()

            expect(result.status).toBe(HttpStatusCode.OK)
            expect(result.details.worker).toEqual(status)
        })

        it('should return SERVICE_UNAVAILABLE when worker runState is FAILED', async () => {
            const service = new WorkerHealthService()
            const status = createWorkerStatus({ runState: 'FAILED' })

            service.setStatusProvider(() => status)

            const result = await service.onHealthCheck()

            expect(result.status).toBe(HttpStatusCode.SERVICE_UNAVAILABLE)
            expect(result.details.worker).toEqual(status)
        })

        it('should return SERVICE_UNAVAILABLE when workflowPollerState is FAILED', async () => {
            const service = new WorkerHealthService()
            const status = createWorkerStatus({ workflowPollerState: 'FAILED' })

            service.setStatusProvider(() => status)

            const result = await service.onHealthCheck()

            expect(result.status).toBe(HttpStatusCode.SERVICE_UNAVAILABLE)
        })

        it('should return SERVICE_UNAVAILABLE when activityPollerState is FAILED', async () => {
            const service = new WorkerHealthService()
            const status = createWorkerStatus({ activityPollerState: 'FAILED' })

            service.setStatusProvider(() => status)

            const result = await service.onHealthCheck()

            expect(result.status).toBe(HttpStatusCode.SERVICE_UNAVAILABLE)
        })

        it('should return SERVICE_UNAVAILABLE when worker is stopping', async () => {
            const service = new WorkerHealthService()
            const status = createWorkerStatus({ runState: 'STOPPING' })

            service.setStatusProvider(() => status)

            const result = await service.onHealthCheck()

            expect(result.status).toBe(HttpStatusCode.SERVICE_UNAVAILABLE)
        })

        it('should return SERVICE_UNAVAILABLE when worker is draining', async () => {
            const service = new WorkerHealthService()
            const status = createWorkerStatus({ runState: 'DRAINING' })

            service.setStatusProvider(() => status)

            const result = await service.onHealthCheck()

            expect(result.status).toBe(HttpStatusCode.SERVICE_UNAVAILABLE)
        })

        it('should return SERVICE_UNAVAILABLE when workflowPollerState is SHUTDOWN', async () => {
            const service = new WorkerHealthService()
            const status = createWorkerStatus({ workflowPollerState: 'SHUTDOWN' })

            service.setStatusProvider(() => status)

            const result = await service.onHealthCheck()

            expect(result.status).toBe(HttpStatusCode.SERVICE_UNAVAILABLE)
        })

        it('should return SERVICE_UNAVAILABLE when activityPollerState is SHUTDOWN', async () => {
            const service = new WorkerHealthService()
            const status = createWorkerStatus({ activityPollerState: 'SHUTDOWN' })

            service.setStatusProvider(() => status)

            const result = await service.onHealthCheck()

            expect(result.status).toBe(HttpStatusCode.SERVICE_UNAVAILABLE)
        })

        it('should include worker metrics in details', async () => {
            const service = new WorkerHealthService()
            const status = createWorkerStatus({
                numInFlightActivities: 5,
                numInFlightWorkflowActivations: 3,
                numCachedWorkflows: 10,
            })

            service.setStatusProvider(() => status)

            const result = await service.onHealthCheck()

            expect(result.status).toBe(HttpStatusCode.OK)

            const workerDetails = result.details.worker as WorkerStatus

            expect(workerDetails.numInFlightActivities).toBe(5)
            expect(workerDetails.numInFlightWorkflowActivations).toBe(3)
            expect(workerDetails.numCachedWorkflows).toBe(10)
        })
    })

    describe('setStatusProvider', () => {
        it('should allow updating the status provider', async () => {
            const service = new WorkerHealthService()
            const status1 = createWorkerStatus({ numInFlightActivities: 1 })
            const status2 = createWorkerStatus({ numInFlightActivities: 2 })

            service.setStatusProvider(() => status1)

            let result = await service.onHealthCheck()

            expect((result.details.worker as WorkerStatus).numInFlightActivities).toBe(1)

            service.setStatusProvider(() => status2)

            result = await service.onHealthCheck()

            expect((result.details.worker as WorkerStatus).numInFlightActivities).toBe(2)
        })
    })
})
