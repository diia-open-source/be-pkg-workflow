import { LogLevel, LogMetadata, Logger as TemporalLogger } from '@temporalio/common'

import { Logger } from '@diia-inhouse/types'

const ERROR_META_KEY = 'error'
const NORMALIZED_ERROR_META_KEY = 'err'

function normalizeMeta(meta?: LogMetadata): LogMetadata | undefined {
    if (!meta || !(ERROR_META_KEY in meta) || NORMALIZED_ERROR_META_KEY in meta) {
        return meta
    }

    const { [ERROR_META_KEY]: error, ...rest } = meta

    return { ...rest, [NORMALIZED_ERROR_META_KEY]: error }
}

/**
 * Adapts a diia `Logger` to the Temporal runtime `Logger`.
 *
 * Remaps failures to the `err` key the diia logger serializes, and implements the
 * level-first `log()` signature the two interfaces disagree on.
 */
export function toTemporalRuntimeLogger(logger: Logger): TemporalLogger {
    const levels: Record<LogLevel, (message: string, meta?: LogMetadata) => void> = {
        TRACE: (message, meta) => logger.trace(message, meta),
        DEBUG: (message, meta) => logger.debug(message, meta),
        INFO: (message, meta) => logger.info(message, meta),
        WARN: (message, meta) => logger.warn(message, meta),
        ERROR: (message, meta) => logger.error(message, meta),
    }

    return {
        log: (level, message, meta) => levels[level]?.(message, normalizeMeta(meta)),
        trace: (message, meta) => levels.TRACE(message, normalizeMeta(meta)),
        debug: (message, meta) => levels.DEBUG(message, normalizeMeta(meta)),
        info: (message, meta) => levels.INFO(message, normalizeMeta(meta)),
        warn: (message, meta) => levels.WARN(message, normalizeMeta(meta)),
        error: (message, meta) => levels.ERROR(message, normalizeMeta(meta)),
    }
}
