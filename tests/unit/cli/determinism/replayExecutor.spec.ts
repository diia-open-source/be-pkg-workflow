import { ReplayWorkerOptions, Worker } from '@temporalio/worker'
import { DeterminismViolationError } from '@temporalio/workflow'
import { vi } from 'vitest'

import { replayBatch, replaySingle } from '../../../../src/cli/determinism/replayExecutor'
import { HistoryEntry } from '../../../../src/cli/determinism/types'

const defaultOptions: ReplayWorkerOptions = { workflowsPath: '/fake/path.js' }
const defaultConfig = { maxRetries: 3, retryDelayMs: 0, timeoutMs: 5000 }

describe('replaySingle', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let mockRunReplayHistory: any

    beforeEach(() => {
        mockRunReplayHistory = vi.spyOn(Worker, 'runReplayHistory' as never)
    })

    it('should return success on first attempt', async () => {
        mockRunReplayHistory.mockResolvedValue()

        const result = await replaySingle(defaultOptions, { events: [] }, 'wf-1', 'MyWorkflow', defaultConfig)

        expect(result).toMatchObject({
            status: 'success',
            workflowId: 'wf-1',
            workflowType: 'MyWorkflow',
            recoveredOnRetry: false,
            failedAttempts: 0,
        })
    })

    it('should retry on transient error and report recovery', async () => {
        mockRunReplayHistory.mockRejectedValueOnce(new Error('transient')).mockResolvedValueOnce()

        const result = await replaySingle(defaultOptions, { events: [] }, 'wf-2', 'MyWorkflow', defaultConfig)

        expect(result).toMatchObject({
            status: 'success',
            recoveredOnRetry: true,
            failedAttempts: 1,
            originalErrors: ['Attempt 1: transient'],
        })
    })

    it('should NOT retry DeterminismViolationError', async () => {
        mockRunReplayHistory.mockRejectedValue(new DeterminismViolationError('non-deterministic'))

        const result = await replaySingle(defaultOptions, { events: [] }, 'wf-3', 'MyWorkflow', defaultConfig)

        expect(result.status).toBe('failure')
        expect(mockRunReplayHistory).toHaveBeenCalledTimes(1)
    })

    it('should return failure after exhausting retries', async () => {
        mockRunReplayHistory
            .mockRejectedValueOnce(new Error('fail-1'))
            .mockRejectedValueOnce(new Error('fail-2'))
            .mockRejectedValueOnce(new Error('fail-3'))

        const result = await replaySingle(defaultOptions, { events: [] }, 'wf-4', 'MyWorkflow', defaultConfig)

        expect(result).toMatchObject({
            status: 'failure',
            error: { errorType: 'ReplayFailure' },
        })
    })

    it('should return timeout when replay exceeds timeoutMs', async () => {
        mockRunReplayHistory.mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 10_000)))

        const result = await replaySingle(defaultOptions, { events: [] }, 'wf-5', 'MyWorkflow', {
            ...defaultConfig,
            maxRetries: 1,
            timeoutMs: 50,
        })

        expect(result).toMatchObject({
            status: 'timeout',
            timeoutMs: 50,
        })
    })

    it('should clean up timer after successful replay (no dangling setTimeout)', async () => {
        const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')

        mockRunReplayHistory.mockResolvedValue()

        await replaySingle(defaultOptions, { events: [] }, 'wf-6', 'MyWorkflow', defaultConfig)

        expect(clearTimeoutSpy).toHaveBeenCalled()
    })
})

describe('replayBatch', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let mockRunReplayHistories: any

    beforeEach(() => {
        mockRunReplayHistories = vi.spyOn(Worker, 'runReplayHistories' as never)
    })

    const entries: HistoryEntry[] = [
        { workflowId: 'wf-1', workflowType: 'WorkflowA', history: { events: [] } },
        { workflowId: 'wf-2', workflowType: 'WorkflowB', history: { events: [] } },
    ]

    it('should yield success for successful replays', async () => {
        mockRunReplayHistories.mockReturnValue(
            (async function* (): AsyncGenerator<{ workflowId: string; runId: string }> {
                yield { workflowId: 'wf-1', runId: 'run-1' }
                yield { workflowId: 'wf-2', runId: 'run-2' }
            })() as never,
        )

        const results = []

        for await (const result of replayBatch(defaultOptions, entries)) {
            results.push(result)
        }

        expect(results).toHaveLength(2)
        expect(results[0].status).toBe('success')
        expect(results[1].status).toBe('success')
    })

    it('should yield failure for DeterminismViolationError', async () => {
        mockRunReplayHistories.mockReturnValue(
            (async function* (): AsyncGenerator<{ workflowId: string; runId: string; error?: Error }> {
                yield { workflowId: 'wf-1', runId: 'run-1', error: new DeterminismViolationError('broken') }
            })() as never,
        )

        const results = []

        for await (const result of replayBatch(defaultOptions, [entries[0]])) {
            results.push(result)
        }

        expect(results).toHaveLength(1)
        expect(results[0]).toMatchObject({
            status: 'failure',
            error: { errorType: 'DeterminismViolation' },
        })
    })

    it('should yield failure for non-DeterminismViolation errors with error details', async () => {
        mockRunReplayHistories.mockReturnValue(
            (async function* (): AsyncGenerator<{ workflowId: string; runId: string; error?: Error }> {
                yield { workflowId: 'wf-1', runId: 'run-1', error: new Error('replay crashed') }
            })() as never,
        )

        const results = []

        for await (const result of replayBatch(defaultOptions, [entries[0]])) {
            results.push(result)
        }

        expect(results).toHaveLength(1)
        expect(results[0]).toMatchObject({
            status: 'failure',
            error: { errorType: 'ReplayFailure', errorMessage: 'replay crashed' },
        })
    })

    it('should match results by workflowId not by index', async () => {
        mockRunReplayHistories.mockReturnValue(
            (async function* (): AsyncGenerator<{ workflowId: string; runId: string; error?: Error }> {
                yield { workflowId: 'wf-2', runId: 'run-2' }
                yield { workflowId: 'wf-1', runId: 'run-1', error: new DeterminismViolationError('broken') }
            })() as never,
        )

        const results = []

        for await (const result of replayBatch(defaultOptions, entries)) {
            results.push(result)
        }

        expect(results).toHaveLength(2)
        expect(results[0]).toMatchObject({ workflowId: 'wf-2', workflowType: 'WorkflowB', status: 'success' })
        expect(results[1]).toMatchObject({ workflowId: 'wf-1', workflowType: 'WorkflowA', status: 'failure' })
    })

    it('should handle unknown workflowId in result gracefully', async () => {
        mockRunReplayHistories.mockReturnValue(
            (async function* (): AsyncGenerator<{ workflowId: string; runId: string }> {
                yield { workflowId: 'unknown-wf', runId: 'run-x' }
            })() as never,
        )

        const results = []

        for await (const result of replayBatch(defaultOptions, entries)) {
            results.push(result)
        }

        expect(results).toHaveLength(1)
        expect(results[0]).toMatchObject({ workflowId: 'unknown-wf', workflowType: 'unknown' })
    })
})
