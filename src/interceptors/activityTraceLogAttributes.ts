import * as otel from '@opentelemetry/api'
import {
    ActivityExecuteInput,
    ActivityInboundCallsInterceptor,
    ActivityOutboundCallsInterceptor,
    GetLogAttributesInput,
    Next,
} from '@temporalio/worker'

import { activeSpanContext, spanContextLogAttributes } from './spanContext.js'

/**
 * Injects trace and span ids into activity log attributes.
 *
 * The SDK logs the activity lifecycle after the OpenTelemetry span has ended, so the inbound hook
 * remembers the span context while it is still active and `getLogAttributes` falls back to it.
 * `Activity started` precedes the chain entirely and stays untraced.
 */
export class ActivityTraceLogAttributesInterceptor implements ActivityInboundCallsInterceptor, ActivityOutboundCallsInterceptor {
    private capturedSpanContext: otel.SpanContext | undefined

    async execute(input: ActivityExecuteInput, next: Next<ActivityInboundCallsInterceptor, 'execute'>): Promise<unknown> {
        this.capturedSpanContext = activeSpanContext() ?? this.capturedSpanContext

        return await next(input)
    }

    getLogAttributes(
        input: GetLogAttributesInput,
        next: Next<ActivityOutboundCallsInterceptor, 'getLogAttributes'>,
    ): Record<string, unknown> {
        const spanContext = activeSpanContext() ?? this.capturedSpanContext

        if (!spanContext) {
            return next(input)
        }

        // Input last: what the OpenTelemetry interceptor already resolved wins.
        return next({ ...spanContextLogAttributes(spanContext), ...input })
    }
}
