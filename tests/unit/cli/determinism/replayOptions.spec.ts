import { vi } from 'vitest'

import { buildReplayOptions, resolveWorkflowsPath } from '../../../../src/cli/determinism/replayOptions'
import { getDataConverter } from '../../../../src/encryption'

vi.mock('../../../../src/encryption', () => ({
    getDataConverter: vi.fn(),
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
