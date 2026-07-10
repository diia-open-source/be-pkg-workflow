/* oxlint-disable vitest/require-mock-type-parameters, unicorn/consistent-function-scoping */
import { describe, expect, it, vi } from 'vitest'

// Mock the workflow runtime: outside a workflow, the real `proxyActivities` throws. The mock
// returns a proxy whose accessed members mimic Temporal's `ActivityFunctionWithOptions` — a
// callable that also carries an `executeWithOptions` method.
vi.mock('@temporalio/workflow', () => {
    const makeProxy = (): unknown =>
        new Proxy(
            {},
            {
                get(_target, name: string): unknown {
                    const fn = (...args: unknown[]): Promise<unknown> => Promise.resolve({ name, args })

                    return Object.assign(fn, {
                        executeWithOptions: (options: unknown, args: unknown[]): Promise<unknown> =>
                            Promise.resolve({ name, options, args }),
                    })
                },
            },
        )

    return {
        proxyActivities: vi.fn(() => makeProxy()),
        proxyLocalActivities: vi.fn(() => makeProxy()),
    }
})

import { proxyActivities, proxyLocalActivities } from '@temporalio/workflow'

import { buildActivitiesProxy } from '../../../src/activities/proxy'

class PaymentActivity {
    async processPayment(_orderId: string, _amount: number): Promise<boolean> {
        return true
    }
}

const workerActivities = { payment: PaymentActivity }

describe('buildActivitiesProxy', () => {
    it('namespaces methods by class name and forwards calls', async () => {
        const activities = buildActivitiesProxy<typeof workerActivities>()
        const payment = activities.payment({ startToCloseTimeout: '30s' })

        const result = (await payment.processPayment('order-1', 100)) as unknown

        expect(vi.mocked(proxyActivities)).toHaveBeenCalledWith({ startToCloseTimeout: '30s' })
        expect(result).toEqual({ name: 'payment.processPayment', args: ['order-1', 100] })
    })

    it('preserves executeWithOptions for per-call options (e.g. staticSummary)', async () => {
        const activities = buildActivitiesProxy<typeof workerActivities>()
        const payment = activities.payment({ startToCloseTimeout: '30s' })

        expect(typeof payment.processPayment.executeWithOptions).toBe('function')

        const result = (await payment.processPayment.executeWithOptions({ startToCloseTimeout: '30s', summary: 'charge customer' }, [
            'order-1',
            100,
        ])) as unknown

        expect(result).toEqual({
            name: 'payment.processPayment',
            options: { startToCloseTimeout: '30s', summary: 'charge customer' },
            args: ['order-1', 100],
        })
    })

    it('uses proxyLocalActivities when the local proxy is requested', () => {
        const activities = buildActivitiesProxy<typeof workerActivities>(true)

        activities.payment({ startToCloseTimeout: '30s' })

        expect(vi.mocked(proxyLocalActivities)).toHaveBeenCalled()
    })
})
