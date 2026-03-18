import { ReplayWorkerOptions, Worker } from '@temporalio/worker'
import { DeterminismViolationError } from '@temporalio/workflow'

import { classifyReplayError } from './errorClassifier'
import { HistoryEntry, ReplayOutcome } from './types'

export interface ReplayConfig {
    maxRetries: number
    retryDelayMs: number
    timeoutMs: number
}

class TimeoutError extends Error {
    override name = 'TimeoutError'

    constructor(readonly timeoutMs: number) {
        super(`Replay timed out after ${timeoutMs / 1000}s`)
    }
}

function runWithTimeout(options: ReplayWorkerOptions, history: unknown, workflowId: string, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new TimeoutError(timeoutMs)), timeoutMs)

        void Worker.runReplayHistory(options, history, workflowId)
            .then(resolve, reject)
            .finally(() => clearTimeout(timer))
    })
}

export async function replaySingle(
    options: ReplayWorkerOptions,
    history: unknown,
    workflowId: string,
    workflowType: string,
    config: ReplayConfig,
): Promise<ReplayOutcome> {
    let failedAttempts = 0
    const originalErrors: string[] = []

    for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
        try {
            if (attempt > 1) {
                const delay = Math.min(config.retryDelayMs * Math.pow(2, attempt - 2), 4000)

                await new Promise((resolve) => setTimeout(resolve, delay))
            }

            await runWithTimeout(options, history, workflowId, config.timeoutMs)

            return {
                status: 'success',
                workflowId,
                workflowType,
                recoveredOnRetry: attempt > 1,
                failedAttempts,
                originalErrors,
            }
        } catch (err) {
            if (err instanceof DeterminismViolationError) {
                const classification = classifyReplayError(workflowId, err)

                return { status: 'failure', workflowId, workflowType, error: classification.entry }
            }

            if (err instanceof TimeoutError) {
                return { status: 'timeout', workflowId, workflowType, timeoutMs: err.timeoutMs }
            }

            failedAttempts++
            originalErrors.push(`Attempt ${attempt}: ${err instanceof Error ? err.message : String(err)}`)
        }
    }

    return {
        status: 'failure',
        workflowId,
        workflowType,
        error: {
            workflowId,
            errorType: 'ReplayFailure',
            errorMessage: `Replay failed after ${config.maxRetries} attempts`,
            details: { originalErrors },
        },
    }
}

const DEFAULT_BATCH_TIMEOUT_MS = 30_000

export async function* replayBatch(
    options: ReplayWorkerOptions,
    entries: HistoryEntry[],
    timeoutMs = DEFAULT_BATCH_TIMEOUT_MS,
): AsyncGenerator<ReplayOutcome> {
    const entryMap = new Map(entries.map((e) => [e.workflowId, e]))
    const entryOrder = entries.map((e) => e.workflowId)
    let nextExpectedIndex = 0

    async function* historyIterator(): AsyncGenerator<{ history: unknown; workflowId: string }> {
        for (const entry of entries) {
            yield { history: entry.history, workflowId: entry.workflowId }
        }
    }

    const iterator = Worker.runReplayHistories(options, historyIterator())[Symbol.asyncIterator]()

    while (true) {
        const nextResult = await Promise.race([
            iterator.next(),
            new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), timeoutMs)),
        ])

        if (nextResult === 'timeout') {
            // The replay stream is stuck — emit timeout for the current expected workflow and abort
            const stuckWorkflowId = entryOrder[nextExpectedIndex]

            if (stuckWorkflowId) {
                const entry = entryMap.get(stuckWorkflowId)

                yield {
                    status: 'timeout',
                    workflowId: stuckWorkflowId,
                    workflowType: entry?.workflowType ?? 'unknown',
                    timeoutMs,
                }
            }

            // Cannot continue — the worker is stuck, remaining workflows won't be processed
            break
        }

        if (nextResult.done) {
            break
        }

        const result = nextResult.value
        const entry = entryMap.get(result.workflowId)
        const workflowType = entry?.workflowType ?? 'unknown'

        // Track progress for timeout detection
        const resultIndex = entryOrder.indexOf(result.workflowId)
        if (resultIndex >= nextExpectedIndex) {
            nextExpectedIndex = resultIndex + 1
        }

        if (result.error) {
            if (result.error instanceof DeterminismViolationError) {
                const classification = classifyReplayError(result.workflowId, result.error)

                yield { status: 'failure', workflowId: result.workflowId, workflowType, error: classification.entry }
            } else {
                yield {
                    status: 'failure',
                    workflowId: result.workflowId,
                    workflowType,
                    error: {
                        workflowId: result.workflowId,
                        errorType: 'ReplayFailure',
                        errorMessage: result.error.message,
                    },
                }
            }
        } else {
            yield {
                status: 'success',
                workflowId: result.workflowId,
                workflowType,
                recoveredOnRetry: false,
                failedAttempts: 0,
                originalErrors: [],
            }
        }
    }
}
