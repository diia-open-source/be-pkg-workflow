import * as otel from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'

export const traceId = '75811cbb45267b73fbd4c196c6b538f0'

export const spanId = 'a538800661c55f48'

export const spanContext: otel.SpanContext = {
    traceId,
    spanId,
    traceFlags: otel.TraceFlags.SAMPLED,
    isRemote: false,
}

/** Replaces the no-op default, under which `context.with()` propagates nothing. */
export function enableContextManager(): () => void {
    const contextManager = new AsyncLocalStorageContextManager()

    contextManager.enable()
    otel.context.setGlobalContextManager(contextManager)

    return (): void => {
        contextManager.disable()
        otel.context.disable()
    }
}

/** Runs `fn` with `spanContext` active. */
export function withActiveSpan<T>(fn: () => T, ctx: otel.SpanContext = spanContext): T {
    return otel.context.with(otel.trace.setSpan(otel.context.active(), otel.trace.wrapSpanContext(ctx)), fn)
}
