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
    type TimerOptions,
    getCurrentDetails,
    setCurrentDetails,
    setHandler,
    setDefaultUpdateHandler,
    setDefaultQueryHandler,
    setWorkflowOptions,
    getRandomStream,
    workflowRandom,
    type WorkflowRandomStream,
    type UnsafeRandomSource,
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
    // Nexus caller-side API: call Nexus operations on another service from within a workflow.
    // The handler-side helpers live in the `@diia-inhouse/workflow/nexus` entry point.
    createNexusServiceClient,
    type NexusServiceClient,
    type NexusServiceClientOptions,
    type NexusOperationHandle,
    NexusOperationCancellationType,
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

export { buildActivitiesProxy } from './activities/index.js'

export * from './interceptors.js'

export function isNonRetryableFailure(err: unknown): err is ActivityFailure {
    if (!(err instanceof ActivityFailure)) {
        return false
    }

    if (err.retryState === RetryState.RETRY_POLICY_NOT_SET || err.retryState === RetryState.MAXIMUM_ATTEMPTS_REACHED) {
        return true
    }

    return err.cause instanceof ApplicationFailure && Boolean(err.cause.nonRetryable)
}
