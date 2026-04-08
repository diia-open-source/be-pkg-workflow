import * as otel from '@opentelemetry/api'
import {
    type GetLogAttributesInput,
    type Next,
    type WorkflowInterceptorsFactory,
    type WorkflowOutboundCallsInterceptor,
} from '@temporalio/workflow'

/** Injects traceId and spanId from OpenTelemetry into workflow log attributes. */
class TraceLogAttributesInterceptor implements WorkflowOutboundCallsInterceptor {
    getLogAttributes(
        input: GetLogAttributesInput,
        next: Next<WorkflowOutboundCallsInterceptor, 'getLogAttributes'>,
    ): Record<string, unknown> {
        const attrs = next(input)
        const span = otel.trace.getSpan(otel.context.active())
        const spanContext = span?.spanContext()

        if (spanContext && otel.isSpanContextValid(spanContext)) {
            attrs.traceId = spanContext.traceId
            attrs.spanId = spanContext.spanId
        }

        return attrs
    }
}

export const interceptors: WorkflowInterceptorsFactory = () => ({
    outbound: [new TraceLogAttributesInterceptor()],
})
