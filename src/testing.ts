export {
    defaultActivityInfo,
    MockActivityEnvironment,
    TestWorkflowEnvironment,
    TimeSkippingWorkflowClient,
    workflowInterceptorModules,
} from '@temporalio/testing'

type ActivityMethods<T> = T extends { prototype: infer P }
    ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { [K in keyof P]?: P[K] extends (...args: any[]) => any ? (...args: Parameters<P[K]>) => ReturnType<P[K]> : never }
    : never

/**
 * Redefines instantiated activities for use in test environments.
 *
 * This function allows to override specific activity methods with mock implementations
 * while preserving the overall activity structure.
 *
 * @example
 * // Original activities object
 * const activities = instantiateActivities(app, workerActivities)
 *
 * // Mock specific methods for testing
 * const mockedActivities = {
 *   ...activities,
 *   ...mockActivities<typeof workerActivities>({
 *     user: {
 *       getProfile: async (userId) => ({ id: userId, name: 'Test User' }),
 *     },
 *     payment: {
 *       process: async () => ({ success: true, transactionId: 'mock-123' })
 *     }
 *   })
 * }
 *
 * @example
 * // Using with test runner
 * await runWorkflow({
 *   workflow: myWorkflow,
 *   args: [workflowInput],
 *   activities: mockedActivities
 * })
 */
export function mockActivities<TActivities extends Record<string, { prototype: unknown }>>(activities: {
    [K in keyof TActivities]?: ActivityMethods<TActivities[K]>
}): Record<string, (...args: unknown[]) => unknown> {
    const result: Record<string, (...args: unknown[]) => unknown> = {}

    for (const activityName in activities) {
        const methods = activities[activityName]

        if (methods) {
            for (const [methodName, method] of Object.entries(methods)) {
                const fullKey = `${activityName}.${methodName}`

                if (typeof method === 'function') {
                    result[fullKey] = method as (...args: unknown[]) => unknown
                }
            }
        }
    }

    return result
}
