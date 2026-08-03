import type { WorkflowExecuteInput, WorkflowInboundCallsInterceptor, WorkflowOutboundCallsInterceptor } from '@temporalio/workflow'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { interceptors } from '../../../src/interceptors/traceLogAttributes'
import { enableContextManager, spanId, traceId, withActiveSpan } from './support/otel'

const executeInput = { args: [], headers: {} } as unknown as WorkflowExecuteInput

const baseAttributes = { workflowType: 'veteranSportApplicationSubmissionWorkflow', sdkComponent: 'worker' }

const identity = <T>(input: T): T => input

interface InterceptorPair {
    inbound: WorkflowInboundCallsInterceptor
    outbound: WorkflowOutboundCallsInterceptor
}

function buildInterceptor(): InterceptorPair {
    const { inbound, outbound } = interceptors()

    return { inbound: inbound![0], outbound: outbound![0] }
}

describe('workflow traceLogAttributes interceptors', () => {
    let disableContextManager: () => void

    beforeAll(() => {
        disableContextManager = enableContextManager()
    })

    afterAll(() => {
        disableContextManager()
    })

    it('should add trace attributes to the lifecycle log of a failed workflow', async () => {
        const { inbound, outbound } = buildInterceptor()

        // Mirrors executeWithLifecycleLogging(): the lifecycle log follows the span, not the chain.
        await expect(
            withActiveSpan(() =>
                inbound.execute!(executeInput, async () => {
                    throw new Error('Activity task failed')
                }),
            ),
        ).rejects.toThrow('Activity task failed')

        expect(outbound.getLogAttributes!(baseAttributes, identity)).toEqual({
            ...baseAttributes,
            trace_id: traceId,
            span_id: spanId,
            trace_flags: '01',
            traceId,
            spanId,
        })
    })

    it('should not overwrite trace attributes already resolved by the OpenTelemetry interceptor', async () => {
        const { inbound, outbound } = buildInterceptor()

        await withActiveSpan(() => inbound.execute!(executeInput, async () => 'result'))

        const attrs = outbound.getLogAttributes!({ ...baseAttributes, trace_id: 'live', span_id: 'live' }, identity)

        expect(attrs).toMatchObject({ trace_id: 'live', span_id: 'live', traceId, spanId })
    })

    it('should not share captured context between workflow executions', async () => {
        const first = buildInterceptor()
        const second = buildInterceptor()

        await withActiveSpan(() => first.inbound.execute!(executeInput, async () => 'result'))

        expect(second.outbound.getLogAttributes!(baseAttributes, identity)).toEqual(baseAttributes)
    })
})
