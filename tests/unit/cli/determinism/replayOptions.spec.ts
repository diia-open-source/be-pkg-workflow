import path from 'node:path'

import { Worker } from '@temporalio/worker'
import { DeterminismViolationError } from '@temporalio/workflow'
import { vi } from 'vitest'

import { buildReplayOptions, resolveWorkflowsPath } from '../../../../src/cli/determinism/replayOptions'
import { getDataConverter } from '../../../../src/encryption'
import { workflowInterceptorModules } from '../../../../src/interceptors/workflowModules'
import history from './support/confirmApplication.history.json'

vi.mock('../../../../src/encryption', () => ({
    getDataConverter: vi.fn<typeof getDataConverter>(),
}))

const mockGetDataConverter = vi.mocked(getDataConverter)

describe('resolveWorkflowsPath', () => {
    it('should resolve workflows path relative to dist/', () => {
        const result = resolveWorkflowsPath('worker/workflows')

        expect(result).toContain('dist')
        expect(result).toContain('worker/workflows')
        expect(result).toContain('index.js')
    })

    it('should throw on path traversal', () => {
        expect(() => resolveWorkflowsPath('../../etc/passwd')).toThrow('path traversal')
    })
})

describe('buildReplayOptions', () => {
    afterEach(() => {
        delete process.env.TRACING_ENABLED
    })

    it('should load the workflows module as an interceptor module', async () => {
        const options = await buildReplayOptions('worker/workflows', { enabled: false, keyId: '' })

        expect(options.interceptors?.workflowModules).toEqual([options.workflowsPath])
    })

    it('should add the trace log attributes module when tracing is enabled', async () => {
        process.env.TRACING_ENABLED = 'true'

        const options = await buildReplayOptions('worker/workflows', { enabled: false, keyId: '' })

        expect(options.interceptors?.workflowModules).toEqual([
            options.workflowsPath,
            expect.stringMatching(/interceptors\/traceLogAttributes$/),
        ])
    })

    it('should build options without encryption', async () => {
        const options = await buildReplayOptions('worker/workflows', { enabled: false, keyId: '' })

        expect(options.workflowsPath).toBeDefined()
        expect(options.dataConverter).toBeUndefined()
    })

    it('should build options with encryption', async () => {
        const mockEnvService = {} as never

        mockGetDataConverter.mockResolvedValue({ key: 'mock-converter' } as never)

        const options = await buildReplayOptions('worker/workflows', { enabled: true, keyId: 'key-1' }, mockEnvService)

        expect(mockGetDataConverter).toHaveBeenCalledWith('key-1', mockEnvService)
        expect(options.dataConverter).toEqual({ key: 'mock-converter' })
    })
})

// Recorded from a worker with tracing enabled.
describe('replaying a workflow with an update', () => {
    const workflowsPath = path.resolve(import.meta.dirname, 'support/workflows.ts')

    it('should pass with the worker interceptor modules', async () => {
        const replay = Worker.runReplayHistory(
            { workflowsPath, interceptors: { workflowModules: workflowInterceptorModules(workflowsPath, true) } },
            history,
        )

        await expect(replay).resolves.toBeUndefined()
    })

    it('should fail without them', async () => {
        await expect(Worker.runReplayHistory({ workflowsPath }, history)).rejects.toThrow(DeterminismViolationError)
    })
})
