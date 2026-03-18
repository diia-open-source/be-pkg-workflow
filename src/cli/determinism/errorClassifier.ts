import { DeterminismViolationError } from '@temporalio/workflow'

import { WorkflowDeterminismError } from './types'

interface DeterminismViolationClassification {
    type: 'determinism-violation'
    subtype: 'activity-mismatch' | 'new-steps-added' | 'other'
    entry: WorkflowDeterminismError
}

interface ReplayFailureClassification {
    type: 'replay-failure'
    subtype: undefined
    entry: WorkflowDeterminismError
}

export type ErrorClassification = DeterminismViolationClassification | ReplayFailureClassification

const activityMismatchRegex = /Activity type of scheduled event '(.+?)' does not match activity type of activity command '(.+?)'/

export function isNewStepsAdded(error: WorkflowDeterminismError): boolean {
    return error.errorType === 'DeterminismViolation' && error.errorMessage.includes('WorkflowExecutionCompleted')
}

export function classifyReplayError(workflowId: string, error: Error): ErrorClassification {
    if (error instanceof DeterminismViolationError) {
        const message = error.message || ''
        const match = message.match(activityMismatchRegex)

        if (match) {
            const [, scheduledEvent, activityCommand] = match

            return {
                type: 'determinism-violation',
                subtype: 'activity-mismatch',
                entry: {
                    workflowId,
                    errorType: 'DeterminismViolation',
                    errorMessage: message,
                    details: {
                        issue: 'Activity Type Mismatch',
                        explanation: `The workflow history expected activity '${scheduledEvent}' but the code attempted to execute '${activityCommand}'`,
                    },
                },
            }
        }

        if (message.includes('WorkflowExecutionCompleted')) {
            return {
                type: 'determinism-violation',
                subtype: 'new-steps-added',
                entry: {
                    workflowId,
                    errorType: 'DeterminismViolation',
                    errorMessage: message,
                    details: {
                        issue: 'New Steps Added',
                        explanation:
                            'This workflow has been modified to add new steps after the point where it previously completed. This is safe to ignore as it does not affect existing history.',
                    },
                },
            }
        }

        return {
            type: 'determinism-violation',
            subtype: 'other',
            entry: {
                workflowId,
                errorType: 'DeterminismViolation',
                errorMessage: message,
            },
        }
    }

    return {
        type: 'replay-failure',
        subtype: undefined,
        entry: {
            workflowId,
            errorType: 'ReplayFailure',
            errorMessage: error.message,
        },
    }
}
