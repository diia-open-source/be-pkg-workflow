import { ActivityFailure, ApplicationFailure, RetryState } from '@temporalio/common'

export {
    allHandlersFinished,
    condition,
    continueAsNew,
    makeContinueAsNewFunc,
    ContinueAsNew,
    type ContinueAsNewOptions,
    setDefaultSignalHandler,
    log,
    workflowInfo,
    type WorkflowInfo,
    currentUpdateInfo,
    workflowMetadataQuery,
    sleep,
    setHandler,
    defineQuery,
    defineSignal,
    defineUpdate,
    executeChild,
    startChild,
    type ChildWorkflowHandle,
    type ChildWorkflowOptions,
    extractWorkflowType,
    upsertMemo,
    upsertSearchAttributes,
    patched,
    deprecatePatch,
    addDefaultWorkflowOptions,
    uuid4,
    isCancellation,
    type CommonWorkflowOptions,
    scheduleActivity,
    scheduleLocalActivity,
    proxyActivities,
    proxyLocalActivities,
    proxySinks,
    inWorkflowContext,
    CancellationScope,
    type CancellationScopeOptions,
    type WorkflowInterceptorsFactory,
    Trigger,
    getExternalWorkflowHandle,
    DeterminismViolationError,
    WorkflowError,
    ApplicationFailure,
    ChildWorkflowFailure,
    ServerFailure,
    TimeoutFailure,
    ActivityFailure,
    CancelledFailure,
    TerminatedFailure,
    TemporalFailure,
} from '@temporalio/workflow'

export { buildActivitiesProxy } from './activities'

export * from './interceptors'

export function isNonRetryableFailure(err: unknown): err is ActivityFailure {
    if (!(err instanceof ActivityFailure)) {
        return false
    }

    if (err.retryState === RetryState.RETRY_POLICY_NOT_SET || err.retryState === RetryState.MAXIMUM_ATTEMPTS_REACHED) {
        return true
    }

    return err.cause instanceof ApplicationFailure && Boolean(err.cause.nonRetryable)
}
