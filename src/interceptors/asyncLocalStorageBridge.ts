import { AsyncLocalStorage } from 'node:async_hooks'

import * as otel from '@opentelemetry/api'
import { Context as ActivityContext } from '@temporalio/activity'
import { ActivityExecuteInput, ActivityInboundCallsInterceptor, Next } from '@temporalio/worker'

import { AlsData, Logger } from '@diia-inhouse/types'

/**
 * Bridges OpenTelemetry trace context to AsyncLocalStorage for Temporal activities.
 *
 * Extracts trace_id from OpenTelemetry span and injects it into AsyncLocalStorage,
 * making it available to services.
 *
 * @example
 * // In a service called from an activity:
 * const traceId = this.asyncLocalStorage.getStore()?.logData?.traceId
 */
export class AsyncLocalStorageBridgeInterceptor implements ActivityInboundCallsInterceptor {
    constructor(
        protected readonly ctx: ActivityContext,
        private readonly asyncLocalStorage: AsyncLocalStorage<AlsData>,
        private readonly logger: Logger,
    ) {}

    async execute(input: ActivityExecuteInput, next: Next<ActivityInboundCallsInterceptor, 'execute'>): Promise<unknown> {
        const span = otel.trace.getSpan(otel.context.active())
        const spanContext = span?.spanContext()
        const traceId = spanContext && otel.isSpanContextValid(spanContext) ? spanContext.traceId : undefined

        const logData = this.logger.prepareContext({ traceId })
        const alsData: AlsData = { logData }

        return await this.asyncLocalStorage.run(alsData, async () => await next(input))
    }
}
