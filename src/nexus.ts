/**
 * Nexus entry point (handler + definition side).
 *
 * Re-exports the helpers needed to DEFINE Nexus services/operations (`nexus-rpc`:
 * `service`, `operation`, `serviceHandler`, `HandlerError`, ...) and to IMPLEMENT their
 * handlers in the worker/activity context (`@temporalio/nexus`:
 * `WorkflowRunOperationHandler`, `startWorkflow`, `getClient`, `log`, `operationInfo`, ...).
 *
 * Register the resulting service handlers on a worker via the `nexusServices` worker option,
 * which `runStandaloneWorker`/`runInProcessWorker`/`initWorker` pass straight through to `Worker.create`.
 *
 * To CALL a Nexus operation from within a workflow, use the caller-side API exported from
 * `@diia-inhouse/workflow/operations` (`createNexusServiceClient`) — kept there because it
 * runs inside the workflow sandbox.
 */
export * from '@temporalio/nexus'

export * from 'nexus-rpc'
