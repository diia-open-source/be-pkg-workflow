import * as otel from '@opentelemetry/api'
import {
    type GetLogAttributesInput,
    type Next,
    type WorkflowExecuteInput,
    type WorkflowInboundCallsInterceptor,
    type WorkflowInterceptorsFactory,
    type WorkflowOutboundCallsInterceptor,
} from '@temporalio/workflow'

import { activeSpanContext, spanContextLogAttributes } from './spanContext.js'

/** Injects trace and span ids into workflow log attributes. */
class TraceLogAttributesInterceptor implements WorkflowInboundCallsInterceptor, WorkflowOutboundCallsInterceptor {
    private capturedSpanContext: otel.SpanContext | undefined

    async execute(input: WorkflowExecuteInput, next: Next<WorkflowInboundCallsInterceptor, 'execute'>): Promise<unknown> {
        this.capturedSpanContext = activeSpanContext() ?? this.capturedSpanContext

        return await next(input)
    }

    getLogAttributes(
        input: GetLogAttributesInput,
        next: Next<WorkflowOutboundCallsInterceptor, 'getLogAttributes'>,
    ): Record<string, unknown> {
        const spanContext = activeSpanContext() ?? this.capturedSpanContext

        if (!spanContext) {
            return next(input)
        }

        // Input last: what the OpenTelemetry interceptor already resolved wins.
        return next({ ...spanContextLogAttributes(spanContext), ...input })
    }
}

export const interceptors: WorkflowInterceptorsFactory = () => {
    const interceptor = new TraceLogAttributesInterceptor()

    return {
        inbound: [interceptor],
        outbound: [interceptor],
    }
}
