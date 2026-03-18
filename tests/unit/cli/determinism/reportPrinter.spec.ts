import { printReport } from '../../../../src/cli/determinism/reportPrinter'
import { DeterminismReport } from '../../../../src/cli/determinism/types'

function createWriter(): { write: (s: string) => void; output: string } {
    let output = ''

    return {
        write(s: string): void {
            output += s
        },
        get output(): string {
            return output
        },
    }
}

// Strip ANSI escape codes for easier assertion
// eslint-disable-next-line no-control-regex
const ansiRegex = /\u001B\[\d+m/g

function stripAnsi(s: string): string {
    return s.replaceAll(ansiRegex, '')
}

function emptyReport(overrides: Partial<DeterminismReport> = {}): DeterminismReport {
    return {
        successCount: 0,
        failureCount: 0,
        timeoutCount: 0,
        skippedCount: 0,
        errors: [],
        warnings: [],
        checkedWorkflows: [],
        ...overrides,
    }
}

describe('printReport', () => {
    describe('banner', () => {
        it('should show PASS when all succeed', () => {
            const writer = createWriter()

            printReport(
                emptyReport({
                    successCount: 3,
                    checkedWorkflows: [
                        { name: 'WFA', id: 'wf-1', status: 'success' },
                        { name: 'WFA', id: 'wf-2', status: 'success' },
                        { name: 'WFB', id: 'wf-3', status: 'success' },
                    ],
                }),
                writer,
            )
            const text = stripAnsi(writer.output)

            expect(text).toContain('PASS')
            expect(text).toContain('All workflows are deterministic')
            expect(text).toContain('3 passed')
        })

        it('should show FAIL when any fail', () => {
            const writer = createWriter()

            printReport(
                emptyReport({
                    successCount: 1,
                    failureCount: 1,
                    errors: [{ workflowId: 'wf-2', errorType: 'DeterminismViolation', errorMessage: 'mismatch' }],
                    checkedWorkflows: [
                        { name: 'WFA', id: 'wf-1', status: 'success' },
                        { name: 'WFB', id: 'wf-2', status: 'failure' },
                    ],
                }),
                writer,
            )
            const text = stripAnsi(writer.output)

            expect(text).toContain('FAIL')
            expect(text).toContain('1 workflow(s) have determinism issues')
        })

        it('should show SKIP when none checked', () => {
            const writer = createWriter()

            printReport(emptyReport(), writer)
            const text = stripAnsi(writer.output)

            expect(text).toContain('SKIP')
            expect(text).toContain('No workflows were checked')
        })

        it('should include timed out and skipped counts when nonzero', () => {
            const writer = createWriter()

            printReport(
                emptyReport({
                    successCount: 5,
                    timeoutCount: 1,
                    skippedCount: 2,
                    checkedWorkflows: [
                        { name: 'WF', id: 'wf-1', status: 'success' },
                        { name: 'WF', id: 'wf-2', status: 'timeout' },
                    ],
                }),
                writer,
            )
            const text = stripAnsi(writer.output)

            expect(text).toContain('1 timed out')
            expect(text).toContain('2 skipped')
        })
    })

    describe('workflow types', () => {
        it('should show deterministic and non-deterministic sections', () => {
            const writer = createWriter()

            printReport(
                emptyReport({
                    successCount: 2,
                    failureCount: 1,
                    errors: [{ workflowId: 'wf-3', errorType: 'DeterminismViolation', errorMessage: 'err' }],
                    checkedWorkflows: [
                        { name: 'GoodWorkflow', id: 'wf-1', status: 'success' },
                        { name: 'GoodWorkflow', id: 'wf-2', status: 'success' },
                        { name: 'BadWorkflow', id: 'wf-3', status: 'failure' },
                    ],
                }),
                writer,
            )
            const text = stripAnsi(writer.output)

            expect(text).toContain('DETERMINISTIC')
            expect(text).toContain('GoodWorkflow')
            expect(text).toContain('2 instances')
            expect(text).toContain('NON-DETERMINISTIC')
            expect(text).toContain('BadWorkflow')
            expect(text).toContain('1 failing')
        })

        it('should show timeout details per type', () => {
            const writer = createWriter()

            printReport(
                emptyReport({
                    successCount: 3,
                    timeoutCount: 1,
                    checkedWorkflows: [
                        { name: 'MixedWorkflow', id: 'wf-1', status: 'success' },
                        { name: 'MixedWorkflow', id: 'wf-2', status: 'success' },
                        { name: 'MixedWorkflow', id: 'wf-3', status: 'success' },
                        { name: 'MixedWorkflow', id: 'wf-4', status: 'timeout' },
                    ],
                }),
                writer,
            )
            const text = stripAnsi(writer.output)

            expect(text).toContain('1 timed out')
            expect(text).toContain('out of 4')
        })

        it('should show skipped count in banner when set', () => {
            const writer = createWriter()

            printReport(
                emptyReport({
                    successCount: 5,
                    skippedCount: 3,
                    checkedWorkflows: [{ name: 'WF', id: 'wf-1', status: 'success' }],
                }),
                writer,
            )
            const text = stripAnsi(writer.output)

            expect(text).toContain('3 skipped')
        })

        it('should not render sections when no workflows checked', () => {
            const writer = createWriter()

            printReport(emptyReport(), writer)
            const text = stripAnsi(writer.output)

            expect(text).not.toContain('DETERMINISTIC')
            expect(text).not.toContain('NON-DETERMINISTIC')
        })
    })

    describe('errors', () => {
        it('should show numbered errors with details', () => {
            const writer = createWriter()

            printReport(
                emptyReport({
                    failureCount: 1,
                    errors: [
                        {
                            workflowId: 'wf-broken',
                            errorType: 'DeterminismViolation',
                            errorMessage: 'mismatch',
                            details: { issue: 'Activity Type Mismatch', explanation: 'test' },
                        },
                    ],
                    checkedWorkflows: [{ name: 'WF', id: 'wf-broken', status: 'failure' }],
                }),
                writer,
            )
            const text = stripAnsi(writer.output)

            expect(text).toContain('1 ERROR')
            expect(text).toContain('wf-broken')
            expect(text).toContain('Activity Type Mismatch')
        })
    })

    describe('warnings', () => {
        it('should group timeout warnings', () => {
            const writer = createWriter()

            printReport(
                emptyReport({
                    successCount: 1,
                    timeoutCount: 2,
                    warnings: [
                        { workflowId: 'wf-slow-1', errorType: 'ReplayFailure', errorMessage: 'Replay timed out after 30s' },
                        { workflowId: 'wf-slow-2', errorType: 'ReplayFailure', errorMessage: 'Replay timed out after 30s' },
                    ],
                    checkedWorkflows: [
                        { name: 'WF', id: 'wf-1', status: 'success' },
                        { name: 'WF', id: 'wf-slow-1', status: 'timeout' },
                        { name: 'WF', id: 'wf-slow-2', status: 'timeout' },
                    ],
                }),
                writer,
            )
            const text = stripAnsi(writer.output)

            expect(text).toContain('2 WARNING')
            expect(text).toContain('2 workflow(s) timed out')
            expect(text).toContain('wf-slow-1')
            expect(text).toContain('wf-slow-2')
        })

        it('should show other warnings inline', () => {
            const writer = createWriter()

            printReport(
                emptyReport({
                    successCount: 1,
                    warnings: [{ workflowId: 'wf-retry', errorType: 'ReplayFailure', errorMessage: 'Recovered on retry' }],
                    checkedWorkflows: [{ name: 'WF', id: 'wf-1', status: 'success' }],
                }),
                writer,
            )
            const text = stripAnsi(writer.output)

            expect(text).toContain('1 WARNING')
            expect(text).toContain('wf-retry')
            expect(text).toContain('Recovered on retry')
        })
    })
})
