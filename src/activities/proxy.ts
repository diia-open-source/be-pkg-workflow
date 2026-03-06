/* eslint-disable no-redeclare */
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { ActivityInterfaceFor, ActivityOptions, proxyActivities, proxyLocalActivities } from '@temporalio/workflow'

type ActivityClass<T> = T extends { prototype: infer P } ? P : never
type LocalActivityOptions = Parameters<typeof proxyLocalActivities>[0]

/**
 * Enhances Temporal activities by prefixing method names with their class name.
 *
 * Wraps Temporal's proxy functions to provide namespacing (e.g., `orderProcessing.processOrder`),
 * improving organization in Temporal's UI and avoiding naming conflicts.
 *
 * @param {boolean} useLocalActivitiesProxy - Use local activities (true) or regular activities (false, default)
 * @returns {Object} Proxy with class name prefixing for activity methods
 *
 * @example
 * import type { workerActivities } from '../activities'
 *
 * const activities = buildActivitiesProxy<typeof workerActivities>();
 *
 * // In workflow
 * const payment = activities.payment({ startToCloseTimeout: '30s' });
 * const order = activities.order({ startToCloseTimeout: '30s' });
 *
 * const success = await payment.processPayment(orderId, amount); // Calls "payment.processPayment" activity
 * if (success) {
 *   return await order.process(orderId); // Calls "order.process" activity
 * }
 */
export function buildActivitiesProxy<TActivity extends Record<string, unknown>>(
    useLocalActivitiesProxy: true,
): {
    [K in keyof TActivity]: (options: LocalActivityOptions) => ActivityInterfaceFor<ActivityClass<TActivity[K]>>
}

export function buildActivitiesProxy<TActivity extends Record<string, unknown>>(
    useLocalActivitiesProxy?: false,
): {
    [K in keyof TActivity]: (options: ActivityOptions) => ActivityInterfaceFor<ActivityClass<TActivity[K]>>
}

export function buildActivitiesProxy<TActivity extends Record<string, unknown>>(useLocalActivitiesProxy = false) {
    type Options = LocalActivityOptions | ActivityOptions

    return new Proxy(
        {} as {
            [K in keyof TActivity]: (options: Options) => ActivityInterfaceFor<ActivityClass<TActivity[K]>>
        },
        {
            get(
                _target,
                activityType: keyof TActivity & string,
            ): <A extends ActivityClass<TActivity[typeof activityType]>>(options: Options) => ActivityInterfaceFor<A> {
                const activityWrapper = <A extends ActivityClass<TActivity[typeof activityType]>>(
                    options: Options,
                ): ActivityInterfaceFor<A> => {
                    const activities = (useLocalActivitiesProxy ? proxyLocalActivities<A>(options) : proxyActivities<A>(options)) as A

                    return new Proxy({} as Record<string, unknown>, {
                        get: function (_target, prop: string): (...args: unknown[]) => Promise<unknown> {
                            const activityName = `${activityType}.${prop}` as keyof A
                            const activityFn = activities[activityName] as (...args: unknown[]) => Promise<unknown>

                            return (...args: unknown[]): Promise<unknown> => {
                                return activityFn(...args)
                            }
                        },
                    }) as ActivityInterfaceFor<A>
                }

                return activityWrapper
            },
        },
    )
}
