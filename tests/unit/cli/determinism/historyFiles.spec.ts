import { existsSync, readFileSync, readdirSync } from 'node:fs'

import { vi } from 'vitest'

import { collectHistoryFiles, loadHistoryEntries, parseHistoryFile } from '../../../../src/cli/determinism/historyFiles'

vi.mock('node:fs', () => ({
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    readdirSync: vi.fn(),
}))

const mockExistsSync = vi.mocked(existsSync)
const mockReadFileSync = vi.mocked(readFileSync)
const mockReaddirSync = vi.mocked(readdirSync)

const makeDirent = (name: string, isDir: boolean): { name: string; isDirectory: () => boolean } => ({
    name,
    isDirectory: (): boolean => isDir,
})

const makeHistoryJson = (type: string): string =>
    JSON.stringify({
        events: [
            {
                eventType: 'EVENT_TYPE_WORKFLOW_EXECUTION_STARTED',
                workflowExecutionStartedEventAttributes: { workflowType: { name: type } },
            },
            { eventType: 'EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED' },
        ],
    })

describe('collectHistoryFiles', () => {
    it('should throw when directory does not exist', () => {
        mockExistsSync.mockReturnValue(false)

        expect(() => collectHistoryFiles('/nonexistent')).toThrow('History directory does not exist: /nonexistent')
    })

    it('should collect .json files from a flat directory', () => {
        mockExistsSync.mockReturnValue(true)
        mockReaddirSync.mockReturnValue([
            makeDirent('wf-1.json', false),
            makeDirent('wf-2.json', false),
            makeDirent('readme.txt', false),
        ] as never)

        const files = collectHistoryFiles('/histories')

        expect(files).toEqual(['/histories/wf-1.json', '/histories/wf-2.json'])
    })

    it('should collect .json files recursively from subdirectories', () => {
        mockExistsSync.mockReturnValue(true)
        mockReaddirSync
            .mockReturnValueOnce([makeDirent('sub', true), makeDirent('root.json', false)] as never)
            .mockReturnValueOnce([makeDirent('nested.json', false)] as never)

        const files = collectHistoryFiles('/histories')

        expect(files).toEqual(['/histories/sub/nested.json', '/histories/root.json'])
    })
})

describe('parseHistoryFile', () => {
    it('should extract workflowType from start event', () => {
        const content = {
            events: [
                {
                    eventType: 'EVENT_TYPE_WORKFLOW_EXECUTION_STARTED',
                    workflowExecutionStartedEventAttributes: {
                        workflowType: { name: 'MyWorkflow' },
                    },
                },
            ],
        }

        mockReadFileSync.mockReturnValue(JSON.stringify(content))

        const entry = parseHistoryFile('/path/wf-123.json')

        expect(entry.workflowId).toBe('wf-123')
        expect(entry.workflowType).toBe('MyWorkflow')
        expect(entry.history).toEqual(content)
    })

    it('should handle content with .history wrapper', () => {
        const history = {
            events: [
                {
                    eventType: 'EVENT_TYPE_WORKFLOW_EXECUTION_STARTED',
                    workflowExecutionStartedEventAttributes: {
                        workflowType: { name: 'WrappedWorkflow' },
                    },
                },
            ],
        }

        mockReadFileSync.mockReturnValue(JSON.stringify({ history }))

        const entry = parseHistoryFile('/path/wf-456.json')

        expect(entry.workflowType).toBe('WrappedWorkflow')
        expect(entry.history).toEqual(history)
    })

    it('should default workflowType to unknown when no start event', () => {
        mockReadFileSync.mockReturnValue(JSON.stringify({ events: [] }))

        const entry = parseHistoryFile('/path/wf-789.json')

        expect(entry.workflowType).toBe('unknown')
    })

    it('should throw on invalid JSON', () => {
        mockReadFileSync.mockReturnValue('not-json{{{')

        expect(() => parseHistoryFile('/path/bad.json')).toThrow('Unexpected token')
    })
})

describe('loadHistoryEntries', () => {
    it('should filter out workflows not in the workflow record', () => {
        mockExistsSync.mockReturnValue(true)
        mockReaddirSync.mockReturnValue([makeDirent('wf-1.json', false), makeDirent('wf-2.json', false)] as never)

        mockReadFileSync.mockReturnValueOnce(makeHistoryJson('KnownWorkflow')).mockReturnValueOnce(makeHistoryJson('UnknownWorkflow'))

        const workflows = { KnownWorkflow: vi.fn() }
        const result = loadHistoryEntries('/dir', workflows)

        expect(result.entries).toHaveLength(1)
        expect(result.entries[0].workflowType).toBe('KnownWorkflow')
    })

    it('should keep workflows with unknown type if completed', () => {
        mockExistsSync.mockReturnValue(true)
        mockReaddirSync.mockReturnValue([makeDirent('wf-1.json', false)] as never)

        mockReadFileSync.mockReturnValue(JSON.stringify({ events: [{ eventType: 'EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED' }] }))

        const result = loadHistoryEntries('/dir', { SomeWorkflow: vi.fn() })

        expect(result.entries).toHaveLength(1)
        expect(result.entries[0].workflowType).toBe('unknown')
    })

    it('should skip running workflows and count them', () => {
        mockExistsSync.mockReturnValue(true)
        mockReaddirSync.mockReturnValue([makeDirent('wf-1.json', false)] as never)

        mockReadFileSync.mockReturnValue(JSON.stringify({ events: [] }))

        const result = loadHistoryEntries('/dir', { SomeWorkflow: vi.fn() })

        expect(result.entries).toHaveLength(0)
        expect(result.runningCount).toBe(1)
    })

    it('should respect limit parameter', () => {
        mockExistsSync.mockReturnValue(true)
        mockReaddirSync.mockReturnValue([
            makeDirent('wf-1.json', false),
            makeDirent('wf-2.json', false),
            makeDirent('wf-3.json', false),
        ] as never)

        mockReadFileSync.mockReturnValue(makeHistoryJson('WF'))

        const result = loadHistoryEntries('/dir', { WF: vi.fn() }, { limit: 2 })

        expect(result.entries).toHaveLength(2)
    })

    it('should skip unparseable files and log warning', () => {
        mockExistsSync.mockReturnValue(true)
        mockReaddirSync.mockReturnValue([makeDirent('good.json', false), makeDirent('bad.json', false)] as never)

        mockReadFileSync.mockReturnValueOnce(makeHistoryJson('WF')).mockReturnValueOnce('invalid json')

        const logger = { warn: vi.fn() }
        const result = loadHistoryEntries('/dir', { WF: vi.fn() }, { logger: logger as never })

        expect(result.entries).toHaveLength(1)
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('bad'))
    })

    it('should skip encrypted workflows when encryption is disabled and count them', () => {
        mockExistsSync.mockReturnValue(true)
        mockReaddirSync.mockReturnValue([makeDirent('wf-enc.json', false)] as never)

        mockReadFileSync.mockReturnValue(
            JSON.stringify({
                events: [
                    {
                        eventType: 'EVENT_TYPE_WORKFLOW_EXECUTION_STARTED',
                        workflowExecutionStartedEventAttributes: {
                            workflowType: { name: 'WF' },
                            input: { payloads: [{ metadata: { encoding: 'YmluYXJ5L2VuY3J5cHRlZA==' } }] },
                        },
                    },
                    { eventType: 'EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED' },
                ],
            }),
        )

        const result = loadHistoryEntries('/dir', { WF: vi.fn() }, { encryptionEnabled: false })

        expect(result.entries).toHaveLength(0)
        expect(result.encryptedCount).toBe(1)
    })

    it('should include encrypted workflows when encryption is enabled', () => {
        mockExistsSync.mockReturnValue(true)
        mockReaddirSync.mockReturnValue([makeDirent('wf-enc.json', false)] as never)

        mockReadFileSync.mockReturnValue(
            JSON.stringify({
                events: [
                    {
                        eventType: 'EVENT_TYPE_WORKFLOW_EXECUTION_STARTED',
                        workflowExecutionStartedEventAttributes: {
                            workflowType: { name: 'WF' },
                            input: { payloads: [{ metadata: { encoding: 'YmluYXJ5L2VuY3J5cHRlZA==' } }] },
                        },
                    },
                    { eventType: 'EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED' },
                ],
            }),
        )

        const result = loadHistoryEntries('/dir', { WF: vi.fn() }, { encryptionEnabled: true })

        expect(result.entries).toHaveLength(1)
        expect(result.encryptedCount).toBe(0)
    })
})
