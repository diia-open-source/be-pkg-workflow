import { DeterminismViolationError } from '@temporalio/workflow'

import { classifyReplayError, isNewStepsAdded } from '../../../../src/cli/determinism/errorClassifier'

describe('isNewStepsAdded', () => {
    it('should return true for DeterminismViolation with WorkflowExecutionCompleted', () => {
        expect(
            isNewStepsAdded({
                workflowId: 'wf-1',
                errorType: 'DeterminismViolation',
                errorMessage: 'Replay failed with non-determinism error: WorkflowExecutionCompleted',
            }),
        ).toBe(true)
    })

    it('should return false for DeterminismViolation without WorkflowExecutionCompleted', () => {
        expect(
            isNewStepsAdded({
                workflowId: 'wf-1',
                errorType: 'DeterminismViolation',
                errorMessage: 'Activity type mismatch',
            }),
        ).toBe(false)
    })

    it('should return false for ReplayFailure even with WorkflowExecutionCompleted in message', () => {
        expect(
            isNewStepsAdded({
                workflowId: 'wf-1',
                errorType: 'ReplayFailure',
                errorMessage: 'WorkflowExecutionCompleted',
            }),
        ).toBe(false)
    })
})

describe('classifyReplayError', () => {
    const workflowId = 'test-workflow-123'

    describe('DeterminismViolationError', () => {
        it('should classify activity type mismatch', () => {
            const error = new DeterminismViolationError(
                "Activity type of scheduled event 'oldActivity' does not match activity type of activity command 'newActivity'",
            )

            const result = classifyReplayError(workflowId, error)

            expect(result.type).toBe('determinism-violation')
            expect(result.subtype).toBe('activity-mismatch')
            expect(result.entry.workflowId).toBe(workflowId)
            expect(result.entry.errorType).toBe('DeterminismViolation')
            expect(result.entry.details).toEqual({
                issue: 'Activity Type Mismatch',
                explanation: "The workflow history expected activity 'oldActivity' but the code attempted to execute 'newActivity'",
            })
        })

        it('should classify new steps added after completion', () => {
            const error = new DeterminismViolationError('Replay failed with non-determinism error: WorkflowExecutionCompleted')

            const result = classifyReplayError(workflowId, error)

            expect(result.type).toBe('determinism-violation')
            expect(result.subtype).toBe('new-steps-added')
            expect(result.entry.errorType).toBe('DeterminismViolation')
            expect(result.entry.details).toEqual({
                issue: 'New Steps Added',
                explanation:
                    'This workflow has been modified to add new steps after the point where it previously completed. This is safe to ignore as it does not affect existing history.',
            })
        })

        it('should classify generic determinism violation', () => {
            const error = new DeterminismViolationError('Some other determinism problem')

            const result = classifyReplayError(workflowId, error)

            expect(result.type).toBe('determinism-violation')
            expect(result.subtype).toBe('other')
            expect(result.entry.errorType).toBe('DeterminismViolation')
            expect(result.entry.errorMessage).toBe('Some other determinism problem')
            expect(result.entry.details).toBeUndefined()
        })
    })

    describe('non-DeterminismViolation errors', () => {
        it('should classify generic Error as replay-failure', () => {
            const error = new Error('Worker crashed unexpectedly')

            const result = classifyReplayError(workflowId, error)

            expect(result.type).toBe('replay-failure')
            expect(result.subtype).toBeUndefined()
            expect(result.entry.workflowId).toBe(workflowId)
            expect(result.entry.errorType).toBe('ReplayFailure')
            expect(result.entry.errorMessage).toBe('Worker crashed unexpectedly')
        })
    })
})
