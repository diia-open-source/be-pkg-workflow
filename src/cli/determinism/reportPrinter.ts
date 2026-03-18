import { format } from 'node:util'

import { CheckedWorkflowStatus, DeterminismReport } from './types'

export interface ReportWriter {
    write(s: string): void
}

const reset = '\u001B[0m'
const bold = '\u001B[1m'
const green = '\u001B[32m'
const red = '\u001B[31m'
const yellow = '\u001B[33m'
const magenta = '\u001B[35m'
const cyan = '\u001B[36m'
const white = '\u001B[37m'
const bgRed = '\u001B[41m'
const bgGreen = '\u001B[42m'
const bgYellow = '\u001B[43m'
const bgBlue = '\u001B[44m'
const dim = '\u001B[2m'

interface TypeStats {
    passed: number
    failed: number
    timedOut: number
}

function collectTypeStats(report: DeterminismReport): Map<string, TypeStats> {
    const map = new Map<string, TypeStats>()

    for (const wf of report.checkedWorkflows) {
        let stats = map.get(wf.name)
        if (!stats) {
            stats = { passed: 0, failed: 0, timedOut: 0 }
            map.set(wf.name, stats)
        }

        const statusMap: Record<CheckedWorkflowStatus, keyof TypeStats> = {
            success: 'passed',
            failure: 'failed',
            timeout: 'timedOut',
        }

        stats[statusMap[wf.status]]++
    }

    return map
}

function formatTypeDetail(stats: TypeStats): string {
    const total = stats.passed + stats.failed + stats.timedOut
    const parts: string[] = []

    if (stats.failed > 0) {
        parts.push(`${red}${stats.failed} failing${reset}`)
    }

    if (stats.timedOut > 0) {
        parts.push(`${yellow}${stats.timedOut} timed out${reset}`)
    }

    if (parts.length === 0) {
        return `${total} instance${total === 1 ? '' : 's'}`
    }

    return `${parts.join(', ')} out of ${total}`
}

function printWorkflowTypes(report: DeterminismReport, w: ReportWriter): void {
    const typeStats = collectTypeStats(report)
    if (typeStats.size === 0) {
        return
    }

    const sorted = Array.from(typeStats.entries()).toSorted((a, b) => a[0].localeCompare(b[0]))
    const deterministic = sorted.filter(([, s]) => s.failed === 0)
    const nonDeterministic = sorted.filter(([, s]) => s.failed > 0)

    if (deterministic.length > 0) {
        w.write(`\n  ${bgGreen}${white}${bold} DETERMINISTIC ${reset}\n\n`)

        for (const [name, stats] of deterministic) {
            w.write(`    ${green}✓${reset} ${bold}${name}${reset} ${dim}(${formatTypeDetail(stats)})${reset}\n`)
        }
    }

    if (nonDeterministic.length > 0) {
        w.write(`\n  ${bgRed}${white}${bold} NON-DETERMINISTIC ${reset}\n\n`)

        for (const [name, stats] of nonDeterministic) {
            w.write(`    ${red}✗${reset} ${bold}${name}${reset} (${formatTypeDetail(stats)})\n`)
        }
    }
}

function printErrors(report: DeterminismReport, w: ReportWriter): void {
    if (report.errors.length === 0) {
        return
    }

    w.write(`\n  ${bgRed}${white}${bold} ${report.errors.length} ERROR${report.errors.length > 1 ? 'S' : ''} ${reset}\n\n`)

    for (const [index, error] of report.errors.entries()) {
        const errorTypeColor = error.errorType === 'DeterminismViolation' ? red : yellow

        w.write(`  ${bold}${index + 1}.${reset} ${cyan}${error.workflowId}${reset}\n`)
        w.write(`     ${errorTypeColor}${error.errorMessage}${reset}\n`)

        if (error.details) {
            for (const [key, value] of Object.entries(error.details)) {
                const formattedValue = typeof value === 'string' ? value : format('%o', value)

                w.write(`     ${magenta}${key}:${reset} ${formattedValue}\n`)
            }
        }

        if (index < report.errors.length - 1) {
            w.write('\n')
        }
    }
}

function printWarnings(report: DeterminismReport, w: ReportWriter): void {
    const encryptionWarnings = report.warnings.filter((x) => x.errorMessage.includes('Encrypted payloads'))
    const timeoutWarnings = report.warnings.filter((x) => x.errorMessage.includes('timed out'))
    const otherWarnings = report.warnings.filter(
        (x) => !x.errorMessage.includes('Encrypted payloads') && !x.errorMessage.includes('timed out'),
    )

    const totalWarnings = encryptionWarnings.length + timeoutWarnings.length + otherWarnings.length
    if (totalWarnings === 0) {
        return
    }

    w.write(`\n  ${bgYellow}${white}${bold} ${totalWarnings} WARNING${totalWarnings > 1 ? 'S' : ''} ${reset}\n\n`)

    if (encryptionWarnings.length > 0) {
        w.write(
            `  ${yellow}⊘${reset} ${bold}${encryptionWarnings.length}${reset} workflow(s) with encrypted payloads — decrypt or provide encryption keys\n`,
        )
    }

    if (timeoutWarnings.length > 0) {
        w.write(`  ${yellow}⏰${reset} ${bold}${timeoutWarnings.length}${reset} workflow(s) timed out during replay\n`)

        if (timeoutWarnings.length <= 5) {
            for (const tw of timeoutWarnings) {
                w.write(`     ${dim}${tw.workflowId}${reset}\n`)
            }
        }
    }

    for (const warning of otherWarnings) {
        w.write(`  ${yellow}⚠${reset}  ${cyan}${warning.workflowId}${reset}: ${warning.errorMessage}\n`)

        if (warning.details) {
            for (const [key, value] of Object.entries(warning.details)) {
                const formattedValue = typeof value === 'string' ? value : format('%o', value)

                w.write(`     ${magenta}${key}:${reset} ${formattedValue}\n`)
            }
        }
    }
}

function printSummaryBanner(report: DeterminismReport, w: ReportWriter): void {
    w.write('\n')

    if (report.failureCount === 0 && report.successCount > 0) {
        w.write(`  ${bgGreen}${white}${bold} PASS ${reset} ${green}All workflows are deterministic${reset}`)
    } else if (report.failureCount > 0) {
        w.write(`  ${bgRed}${white}${bold} FAIL ${reset} ${red}${report.failureCount} workflow(s) have determinism issues${reset}`)
    } else {
        w.write(`  ${bgYellow}${white}${bold} SKIP ${reset} ${yellow}No workflows were checked${reset}`)
    }

    const parts: string[] = [`${green}${report.successCount}${reset} passed`]

    if (report.failureCount > 0) {
        parts.push(`${red}${report.failureCount}${reset} failed`)
    }

    if (report.timeoutCount > 0) {
        parts.push(`${yellow}${report.timeoutCount}${reset} timed out`)
    }

    if (report.skippedCount > 0) {
        parts.push(`${dim}${report.skippedCount}${reset} skipped`)
    }

    const total = report.successCount + report.failureCount + report.timeoutCount + report.skippedCount

    w.write(` ${dim}(${parts.join(', ')}, ${bold}${total}${reset}${dim} total)${reset}\n\n`)
}

export function printReport(report: DeterminismReport, writer: ReportWriter = process.stdout): void {
    writer.write('\n')
    writer.write(`  ${bgBlue}${bold}${white} WORKFLOW DETERMINISM CHECK ${reset}\n`)

    printWorkflowTypes(report, writer)
    printErrors(report, writer)
    printWarnings(report, writer)
    printSummaryBanner(report, writer)
}
