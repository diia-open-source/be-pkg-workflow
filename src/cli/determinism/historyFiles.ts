import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

import { HistoryEntry, WorkflowRecord } from './types'

const ENCRYPTED_ENCODING = 'YmluYXJ5L2VuY3J5cHRlZA==' // base64 of 'binary/encrypted'

export function collectHistoryFiles(dir: string): string[] {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const dirExists = existsSync(dir) // nosemgrep: eslint.detect-non-literal-fs-filename

    if (!dirExists) {
        throw new Error(`History directory does not exist: ${dir}`)
    }

    const files: string[] = []
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const entries = readdirSync(dir, { withFileTypes: true }) // nosemgrep: eslint.detect-non-literal-fs-filename

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
            files.push(...collectHistoryFiles(fullPath))
        } else if (entry.name.endsWith('.json')) {
            files.push(fullPath)
        }
    }

    return files
}

const TERMINAL_EVENT_TYPES = new Set([
    'EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED',
    'EVENT_TYPE_WORKFLOW_EXECUTION_FAILED',
    'EVENT_TYPE_WORKFLOW_EXECUTION_TIMED_OUT',
    'EVENT_TYPE_WORKFLOW_EXECUTION_CANCELED',
    'EVENT_TYPE_WORKFLOW_EXECUTION_TERMINATED',
])

export function parseHistoryFile(filePath: string): HistoryEntry & { encrypted: boolean; running: boolean } {
    const workflowId = path.basename(filePath, '.json')
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const content = JSON.parse(readFileSync(filePath, 'utf8')) // nosemgrep: eslint.detect-non-literal-fs-filename
    const history = content.history ?? content
    const events = history.events ?? []
    const startEvent = events.find((e: { eventType?: string }) => e.eventType === 'EVENT_TYPE_WORKFLOW_EXECUTION_STARTED')
    const workflowType = startEvent?.workflowExecutionStartedEventAttributes?.workflowType?.name ?? 'unknown'
    const encrypted = hasEncryptedPayloads(events)
    const running = !events.some((e: { eventType?: string }) => TERMINAL_EVENT_TYPES.has(e.eventType ?? ''))

    return { workflowId, workflowType, history, encrypted, running }
}

function hasEncryptedPayloads(events: Record<string, unknown>[]): boolean {
    for (const event of events) {
        for (const [key, val] of Object.entries(event)) {
            if (!key.includes('Attributes') || typeof val !== 'object' || val === null) {
                continue
            }

            for (const nested of Object.values(val as Record<string, unknown>)) {
                if (typeof nested !== 'object' || nested === null) {
                    continue
                }

                const payloads = (nested as Record<string, unknown>).payloads as { metadata?: { encoding?: string } }[] | undefined

                if (!Array.isArray(payloads)) {
                    continue
                }

                for (const payload of payloads) {
                    if (payload.metadata?.encoding === ENCRYPTED_ENCODING) {
                        return true
                    }
                }
            }
        }
    }

    return false
}

export interface LoadHistoryResult {
    entries: HistoryEntry[]
    encryptedCount: number
    runningCount: number
}

export function loadHistoryEntries(
    historyDir: string,
    workflows: WorkflowRecord,
    options: { limit?: number; encryptionEnabled?: boolean; logger?: { warn: (msg: string) => void } } = {},
): LoadHistoryResult {
    const { limit, encryptionEnabled = false, logger } = options
    let historyFiles = collectHistoryFiles(historyDir)

    if (limit && limit > 0 && historyFiles.length > limit) {
        historyFiles = historyFiles.slice(0, limit)
    }

    const entries: HistoryEntry[] = []
    let encryptedCount = 0
    let runningCount = 0

    for (const filePath of historyFiles) {
        try {
            const entry = parseHistoryFile(filePath)

            if (entry.workflowType !== 'unknown' && !workflows[entry.workflowType]) {
                continue
            }

            if (entry.running) {
                runningCount++
                continue
            }

            if (entry.encrypted && !encryptionEnabled) {
                encryptedCount++
                continue
            }

            entries.push(entry)
        } catch (err) {
            const workflowId = path.basename(filePath, '.json')

            logger?.warn(`Skipping ${workflowId} — failed to parse: ${(err as Error).message}`)
        }
    }

    return { entries, encryptedCount, runningCount }
}
