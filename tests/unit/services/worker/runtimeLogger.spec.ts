import { describe, expect, it, vi } from 'vitest'

import type { LogData, Logger } from '@diia-inhouse/types'

import { toTemporalRuntimeLogger } from '../../../../src/services/worker/runtimeLogger'

type LogMethod = (message: string, data?: unknown) => void

function buildLogger(): Logger {
    return {
        log: vi.fn<LogMethod>(),
        info: vi.fn<LogMethod>(),
        error: vi.fn<LogMethod>(),
        warn: vi.fn<LogMethod>(),
        fatal: vi.fn<LogMethod>(),
        trace: vi.fn<LogMethod>(),
        debug: vi.fn<LogMethod>(),
        io: vi.fn<LogMethod>(),
        child: vi.fn<(bindings: Record<string, unknown>) => Logger>(),
        prepareContext: vi.fn<(context: LogData) => LogData>(),
    }
}

describe('toTemporalRuntimeLogger', () => {
    it('should leave metadata alone when it carries no error or already has err', () => {
        const logger = buildLogger()
        const err = new Error('already normalized')
        const meta = { workflowId: 'veteran-sport-application-submission-6a5f061ad575895617a04aba' }

        const runtimeLogger = toTemporalRuntimeLogger(logger)

        runtimeLogger.info('Starting Temporal worker', meta)
        runtimeLogger.error('Activity failed', { err, error: new Error('other') })
        runtimeLogger.debug('Activity started')

        expect(logger.info).toHaveBeenCalledWith('Starting Temporal worker', meta)
        expect(logger.error).toHaveBeenCalledWith('Activity failed', expect.objectContaining({ err }))
        expect(logger.debug).toHaveBeenCalledWith('Activity started', undefined)
    })

    it('should dispatch the level-first log() signature to the matching method', () => {
        const logger = buildLogger()
        const error = new Error('core failure')

        toTemporalRuntimeLogger(logger).log('WARN', 'Error converting native log entry', { error })

        expect(logger.warn).toHaveBeenCalledWith('Error converting native log entry', { err: error })
        expect(logger.log).not.toHaveBeenCalled()
    })
})
