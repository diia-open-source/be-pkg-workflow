import { DeterminismReportBuilder } from '../../../../src/cli/determinism/report'

describe('DeterminismReportBuilder', () => {
    let builder: DeterminismReportBuilder

    beforeEach(() => {
        builder = new DeterminismReportBuilder()
    })

    describe('addSuccess', () => {
        it('should increment successCount and add to checkedWorkflows', () => {
            builder.addSuccess('wf-1', 'MyWorkflow')

            const report = builder.build()

            expect(report.successCount).toBe(1)
            expect(report.failureCount).toBe(0)
            expect(report.timeoutCount).toBe(0)
            expect(report.skippedCount).toBe(0)
            expect(report.checkedWorkflows).toEqual([{ name: 'MyWorkflow', id: 'wf-1', status: 'success' }])
        })
    })

    describe('addFailure', () => {
        it('should increment failureCount and add error and checkedWorkflow', () => {
            const error = {
                workflowId: 'wf-2',
                errorType: 'DeterminismViolation' as const,
                errorMessage: 'mismatch',
            }

            builder.addFailure('wf-2', 'BadWorkflow', error)

            const report = builder.build()

            expect(report.failureCount).toBe(1)
            expect(report.successCount).toBe(0)
            expect(report.errors).toEqual([error])
            expect(report.checkedWorkflows).toEqual([{ name: 'BadWorkflow', id: 'wf-2', status: 'failure' }])
        })
    })

    describe('addTimeout', () => {
        it('should increment timeoutCount but NOT successCount', () => {
            const warning = {
                workflowId: 'wf-3',
                errorType: 'ReplayFailure' as const,
                errorMessage: 'Replay timed out after 30s',
            }

            builder.addTimeout('wf-3', 'SlowWorkflow', warning)

            const report = builder.build()

            expect(report.timeoutCount).toBe(1)
            expect(report.successCount).toBe(0)
            expect(report.failureCount).toBe(0)
            expect(report.warnings).toEqual([warning])
            expect(report.checkedWorkflows).toEqual([{ name: 'SlowWorkflow', id: 'wf-3', status: 'timeout' }])
        })
    })

    describe('setSkippedCount', () => {
        it('should set skippedCount without affecting other counts or checkedWorkflows', () => {
            builder.setSkippedCount(5)

            const report = builder.build()

            expect(report.skippedCount).toBe(5)
            expect(report.successCount).toBe(0)
            expect(report.failureCount).toBe(0)
            expect(report.timeoutCount).toBe(0)
            expect(report.checkedWorkflows).toEqual([])
        })
    })

    describe('addWarning', () => {
        it('should add warning without affecting counts', () => {
            const warning = {
                workflowId: 'wf-4',
                errorType: 'ReplayFailure' as const,
                errorMessage: 'Recovered on retry',
            }

            builder.addWarning(warning)

            const report = builder.build()

            expect(report.warnings).toEqual([warning])
            expect(report.successCount).toBe(0)
            expect(report.failureCount).toBe(0)
            expect(report.timeoutCount).toBe(0)
            expect(report.skippedCount).toBe(0)
        })
    })

    describe('build', () => {
        it('should aggregate multiple operations correctly', () => {
            builder.addSuccess('wf-1', 'GoodWorkflow')
            builder.addSuccess('wf-2', 'GoodWorkflow')
            builder.addFailure('wf-3', 'BadWorkflow', {
                workflowId: 'wf-3',
                errorType: 'DeterminismViolation',
                errorMessage: 'broken',
            })
            builder.addTimeout('wf-4', 'SlowWorkflow', {
                workflowId: 'wf-4',
                errorType: 'ReplayFailure',
                errorMessage: 'timed out',
            })
            builder.setSkippedCount(3)
            builder.addWarning({
                workflowId: 'wf-1',
                errorType: 'ReplayFailure',
                errorMessage: 'recovered',
            })

            const report = builder.build()

            expect(report.successCount).toBe(2)
            expect(report.failureCount).toBe(1)
            expect(report.timeoutCount).toBe(1)
            expect(report.skippedCount).toBe(3)
            expect(report.errors).toHaveLength(1)
            expect(report.warnings).toHaveLength(2)
            expect(report.checkedWorkflows).toHaveLength(4)
        })

        it('should return empty report when nothing added', () => {
            const report = builder.build()

            expect(report.successCount).toBe(0)
            expect(report.failureCount).toBe(0)
            expect(report.timeoutCount).toBe(0)
            expect(report.skippedCount).toBe(0)
            expect(report.errors).toEqual([])
            expect(report.warnings).toEqual([])
            expect(report.checkedWorkflows).toEqual([])
        })
    })
})
