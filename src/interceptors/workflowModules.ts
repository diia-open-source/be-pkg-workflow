import path from 'node:path'

const traceLogAttributesModulePath = path.resolve(import.meta.dirname, 'traceLogAttributes')

/** Workflow interceptor modules the worker loads. Replay uses the same list. */
export function workflowInterceptorModules(workflowsPath: string | undefined, tracingEnabled: boolean): string[] {
    const modules = workflowsPath ? [workflowsPath] : []

    return tracingEnabled ? [...modules, traceLogAttributesModulePath] : modules
}
