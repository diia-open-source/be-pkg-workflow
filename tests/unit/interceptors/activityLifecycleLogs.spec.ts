import * as otel from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import type { LogLevel, LogMetadata, Logger } from '@temporalio/common'
import { MockActivityEnvironment } from '@temporalio/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildWorkerInterceptors } from '../../../src/services/worker'

interface CapturedLog {
    level: LogLevel
    message: string
    meta?: LogMetadata
}

// The real wiring, so a reordering of the factories in buildWorkerInterceptors fails here.
const activityInterceptors = buildWorkerInterceptors(true, undefined, undefined, undefined)!.activity!

function buildCapturingLogger(logs: CapturedLog[]): Logger {
    const push =
        (level: LogLevel) =>
        (message: string, meta?: LogMetadata): void => {
            logs.push({ level, message, meta })
        }

    return {
        log: (level, message, meta) => logs.push({ level, message, meta }),
        trace: push('TRACE'),
        debug: push('DEBUG'),
        info: push('INFO'),
        warn: push('WARN'),
        error: push('ERROR'),
    }
}

/** End-to-end check through the real `Activity` class that emits these logs. */
describe('activity lifecycle logs', () => {
    let provider: NodeTracerProvider
    let contextManager: AsyncLocalStorageContextManager

    beforeAll(() => {
        contextManager = new AsyncLocalStorageContextManager()
        contextManager.enable()
        otel.context.setGlobalContextManager(contextManager)

        provider = new NodeTracerProvider()
        otel.trace.setGlobalTracerProvider(provider)
    })

    afterAll(async () => {
        await provider.shutdown()
        contextManager.disable()
        otel.context.disable()
        otel.trace.disable()
    })

    it('should carry trace and span ids on the Activity failed log', async () => {
        const logs: CapturedLog[] = []
        const env = new MockActivityEnvironment(
            { activityType: 'veteranSportApplicationSubmission.sendApplication', attempt: 6 },
            { interceptors: activityInterceptors, logger: buildCapturingLogger(logs) },
        )

        let spanContextInsideActivity: otel.SpanContext | undefined

        await expect(
            env.run(async () => {
                spanContextInsideActivity = otel.trace.getSpan(otel.context.active())?.spanContext()

                throw new Error('Veteran ext_service_eveteran error 500')
            }),
        ).rejects.toThrow('Veteran ext_service_eveteran error 500')

        const failure = logs.find((entry) => entry.message === 'Activity failed')

        expect(spanContextInsideActivity).toBeDefined()
        expect(failure).toBeDefined()
        expect(failure!.meta).toMatchObject({
            activityType: 'veteranSportApplicationSubmission.sendApplication',
            attempt: 6,
            traceId: spanContextInsideActivity!.traceId,
            spanId: spanContextInsideActivity!.spanId,
            trace_id: spanContextInsideActivity!.traceId,
            span_id: spanContextInsideActivity!.spanId,
        })
    })
})
