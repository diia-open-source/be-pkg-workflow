import * as otel from '@opentelemetry/api'

/** Span context of the active span, if any. */
export function activeSpanContext(): otel.SpanContext | undefined {
    const spanContext = otel.trace.getSpan(otel.context.active())?.spanContext()

    return spanContext && otel.isSpanContextValid(spanContext) ? spanContext : undefined
}

/** Trace log attributes, in both the Temporal SDK and the diia naming. */
export function spanContextLogAttributes(spanContext: otel.SpanContext): Record<string, string> {
    return {
        trace_id: spanContext.traceId,
        span_id: spanContext.spanId,
        trace_flags: `0${spanContext.traceFlags.toString(16)}`,
        traceId: spanContext.traceId,
        spanId: spanContext.spanId,
    }
}
