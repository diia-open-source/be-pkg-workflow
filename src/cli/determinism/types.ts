// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WorkflowRecord = Record<string, (...args: any[]) => any>

export interface WorkflowDeterminismError {
    workflowId: string
    errorType: 'DeterminismViolation' | 'ReplayFailure'
    errorMessage: string
    details?: Record<string, unknown>
}

export type CheckedWorkflowStatus = 'success' | 'failure' | 'timeout'

export interface DeterminismReport {
    successCount: number
    failureCount: number
    timeoutCount: number
    skippedCount: number // encrypted workflows skipped before replay (encryption disabled)
    errors: WorkflowDeterminismError[]
    warnings: WorkflowDeterminismError[]
    checkedWorkflows: {
        name: string
        id: string
        status: CheckedWorkflowStatus
    }[]
}

export interface HistoryEntry {
    workflowId: string
    workflowType: string
    history: unknown
}

export type ReplayOutcome =
    | {
          status: 'success'
          workflowId: string
          workflowType: string
          recoveredOnRetry: boolean
          failedAttempts: number
          originalErrors: string[]
      }
    | { status: 'failure'; workflowId: string; workflowType: string; error: WorkflowDeterminismError }
    | { status: 'timeout'; workflowId: string; workflowType: string; timeoutMs: number }
