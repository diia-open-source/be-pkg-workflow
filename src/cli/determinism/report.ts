import { CheckedWorkflowStatus, DeterminismReport, WorkflowDeterminismError } from './types'

export class DeterminismReportBuilder {
    private successCount = 0
    private failureCount = 0
    private timeoutCount = 0
    private skippedCount = 0
    private readonly errors: WorkflowDeterminismError[] = []
    private readonly warnings: WorkflowDeterminismError[] = []
    private readonly checkedWorkflows: { name: string; id: string; status: CheckedWorkflowStatus }[] = []

    addSuccess(workflowId: string, workflowType: string): void {
        this.successCount++
        this.checkedWorkflows.push({ name: workflowType, id: workflowId, status: 'success' })
    }

    addFailure(workflowId: string, workflowType: string, error: WorkflowDeterminismError): void {
        this.failureCount++
        this.errors.push(error)
        this.checkedWorkflows.push({ name: workflowType, id: workflowId, status: 'failure' })
    }

    addTimeout(workflowId: string, workflowType: string, warning: WorkflowDeterminismError): void {
        this.timeoutCount++
        this.warnings.push(warning)
        this.checkedWorkflows.push({ name: workflowType, id: workflowId, status: 'timeout' })
    }

    setSkippedCount(count: number): void {
        this.skippedCount = count
    }

    addWarning(warning: WorkflowDeterminismError): void {
        this.warnings.push(warning)
    }

    build(): DeterminismReport {
        return {
            successCount: this.successCount,
            failureCount: this.failureCount,
            timeoutCount: this.timeoutCount,
            skippedCount: this.skippedCount,
            errors: [...this.errors],
            warnings: [...this.warnings],
            checkedWorkflows: [...this.checkedWorkflows],
        }
    }
}
