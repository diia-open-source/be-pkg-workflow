/* eslint-disable unicorn/no-process-exit */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { stdout } from 'node:process'
import { format } from 'node:util'

import { ReplayWorkerOptions, Runtime, Worker } from '@temporalio/worker'
import { DeterminismViolationError } from '@temporalio/workflow'
import { register } from 'ts-node'

import { EnvService } from '@diia-inhouse/env'
import { Logger } from '@diia-inhouse/types'
import { utils } from '@diia-inhouse/utils'

import { getDataConverter } from '../encryption'
import { TemporalConfig } from '../interfaces'
import { TemporalClient } from '../services/client'

register()

interface WorkflowDeterminismError {
    workflowId: string
    errorType: 'DeterminismViolation' | 'ReplayFailure'
    errorMessage: string
    details?: Record<string, unknown>
}

interface DeterminismReport {
    successCount: number
    failureCount: number
    errors: WorkflowDeterminismError[]
    warnings: WorkflowDeterminismError[]
    checkedWorkflows: {
        name: string
        id: string
        status: 'success' | 'failure'
    }[]
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WorkflowRecord = Record<string, (...args: any[]) => any>

export class CheckWorkflowDeterminismCommand {
    private temporalConfig!: TemporalConfig
    private report: DeterminismReport = {
        successCount: 0,
        failureCount: 0,
        errors: [],
        warnings: [],
        checkedWorkflows: [],
    }
    private readonly maxWorkflowsPerType = 10
    private readonly maxRetries = 3
    private readonly retryDelay = 100

    constructor(
        private readonly logger: Logger,
        private readonly envService: EnvService,
    ) {}

    async run(workflowsPath = 'worker/workflows', taskQueueParam?: string, workflowId?: string): Promise<void> {
        const startTime = Date.now()

        Runtime.install({ logger: this.logger })

        this.logger.info('Starting workflow determinism check', { workflowsPath, taskQueue: taskQueueParam, workflowId })

        const workflows = await this.loadWorkflows(workflowsPath)

        this.logger.info(`Found ${Object.keys(workflows).length} workflows`, { workflows: Object.keys(workflows) })

        const taskQueue = taskQueueParam || this.getTaskQueue()
        if (!taskQueue) {
            throw new Error('Task queue is not provided')
        }

        this.temporalConfig = {
            address: EnvService.getVar('TEMPORAL_ADDRESS'),
            namespace: EnvService.getVar('TEMPORAL_NAMESPACE', 'string', 'default'),
            taskQueue,
            encryptionEnabled: EnvService.getVar('TEMPORAL_ENCRYPTION_ENABLED', 'boolean', false),
            encryptionKeyId: EnvService.getVar('TEMPORAL_ENCRYPTION_KEY_ID', 'string', ''),
        }

        const client = new TemporalClient(this.temporalConfig, this.envService, this.logger)

        await client.onInit()

        try {
            await this.checkWorkflowDeterminism(client, workflowsPath, workflowId)
            this.logger.info(`Workflow determinism check finished! It took ${((Date.now() - startTime) / 1000).toFixed(1)} seconds`)

            if (this.report.failureCount > 0) {
                this.logger.error(`Determinism check failed: ${this.report.failureCount} workflows have determinism issues`)

                process.exit(1)
            }
        } finally {
            await client.nativeClient.connection.close()
        }

        process.exit(0)
    }

    private async checkWorkflowDeterminism(client: TemporalClient, workflowsPath: string, specificWorkflowId?: string): Promise<void> {
        try {
            this.report = {
                successCount: 0,
                failureCount: 0,
                errors: [],
                warnings: [],
                checkedWorkflows: [],
            }

            if (specificWorkflowId) {
                try {
                    await this.checkSingleWorkflow(client, workflowsPath, specificWorkflowId)
                    this.report.successCount++
                } catch {
                    const workflow = this.report.checkedWorkflows.find((w) => w.id === specificWorkflowId)
                    if (workflow && workflow.status === 'success') {
                        this.report.successCount++
                    } else {
                        this.report.failureCount++
                    }
                }

                this.printBeautifulResults()

                return
            }

            const completedOrFailedWorkflows = await this.listCompletedOrFailedWorkflows(client, workflowsPath)
            if (completedOrFailedWorkflows.length === 0) {
                this.logger.info('No completed or failed workflows found to check')

                return
            }

            this.logger.info(
                `Found ${completedOrFailedWorkflows.length} completed or failed workflows to check (limited to max 10 per workflow type)`,
            )

            for (const [i, workflowId] of completedOrFailedWorkflows.entries()) {
                if (i > 0) {
                    await new Promise((resolve) => setTimeout(resolve, this.retryDelay))
                }

                try {
                    await this.checkSingleWorkflow(client, workflowsPath, workflowId)
                    this.report.successCount++
                } catch {
                    const workflow = this.report.checkedWorkflows.find((w) => w.id === workflowId)
                    if (workflow && workflow.status === 'success') {
                        this.report.successCount++
                    } else {
                        this.report.failureCount++
                        this.logger.error(`❌ Failed to check workflow ${workflowId}`)
                    }
                }
            }

            this.printBeautifulResults()
        } catch (err) {
            this.logger.error('❌ Failed to check workflow determinism', { err })
            throw err
        }
    }

    private async runReplayHistory(
        workflowsPath: string,
        history: unknown,
        workflowId: string,
    ): Promise<{ recoveredOnRetry: boolean; failedAttempts: number; originalErrors: string[] }> {
        const fullPath = this.resolveWorkflowsPath(workflowsPath)
        const options: ReplayWorkerOptions = { workflowsPath: require.resolve(fullPath) }

        if (this.temporalConfig.encryptionEnabled) {
            const dataConverter = await getDataConverter(this.temporalConfig.encryptionKeyId, this.envService)

            options.dataConverter = dataConverter
        }

        return await this.runReplayHistoryWithRetry(options, history, workflowId)
    }

    private async runReplayHistoryWithRetry(
        options: ReplayWorkerOptions,
        history: unknown,
        workflowId: string,
        maxRetries = this.maxRetries,
    ): Promise<{ recoveredOnRetry: boolean; failedAttempts: number; originalErrors: string[] }> {
        let lastError: Error | undefined
        let failedAttempts = 0
        const originalErrors: string[] = []

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                if (attempt > 1) {
                    const delay = Math.min(1000 * Math.pow(2, attempt - 2), 5000) // Exponential backoff, max 5s

                    this.logger.info(
                        `Retrying replay history for workflow ${workflowId} (attempt ${attempt}/${maxRetries}) after ${delay}ms delay`,
                    )
                    await new Promise((resolve) => setTimeout(resolve, delay))
                }

                await Worker.runReplayHistory(options, history, workflowId)

                return { recoveredOnRetry: attempt > 1, failedAttempts, originalErrors }
            } catch (err) {
                if (err instanceof DeterminismViolationError) {
                    throw err
                }

                failedAttempts++
                lastError = err as Error
                const errorMessage = err instanceof Error ? err.message : String(err)

                originalErrors.push(`Attempt ${attempt}: ${errorMessage}`)
                this.logger.warn(`🔁 Failed to replay history for workflow ${workflowId} on attempt ${attempt}/${maxRetries}`, { err })

                continue
            }
        }

        throw lastError ?? new Error('Unknown error during replay history retry')
    }

    private async checkSingleWorkflow(client: TemporalClient, workflowsPath: string, workflowId: string): Promise<void> {
        this.logger.info(`Checking workflow ${workflowId}`)

        const handle = client.workflow.getHandle(workflowId)
        const history = await handle.fetchHistory()
        const description = await handle.describe()
        const workflowName = description.type

        try {
            this.logger.info(`Checking determinism for workflow functions in ${workflowId}`)

            const retryResult = await this.runReplayHistory(workflowsPath, history, workflowId)

            this.logger.info(`✅ Workflow ${workflowId} is deterministic`)

            if (retryResult.recoveredOnRetry) {
                this.report.warnings.push({
                    workflowId,
                    errorType: 'ReplayFailure',
                    errorMessage: `Workflow failed ${retryResult.failedAttempts} time(s) but recovered on retry`,
                    details: {
                        issue: 'Workflow Recovered on Retry',
                        explanation: `This workflow initially failed replay but succeeded after ${retryResult.failedAttempts} failed attempt(s). This may indicate transient issues or race conditions.`,
                        failedAttempts: retryResult.failedAttempts,
                        originalErrors: retryResult.originalErrors,
                    },
                })

                this.logger.warn(`⚠️ Workflow ${workflowId} recovered after ${retryResult.failedAttempts} failed attempt(s)`)
            }

            this.report.checkedWorkflows.push({
                name: workflowName,
                id: workflowId,
                status: 'success',
            })
        } catch (err) {
            this.report.checkedWorkflows.push({
                name: workflowName,
                id: workflowId,
                status: 'failure',
            })
            if (err instanceof DeterminismViolationError) {
                const errorMessage = err.message || ''
                const activityMismatchRegex =
                    /Activity type of scheduled event '(.+?)' does not match activity type of activity command '(.+?)'/
                const match = errorMessage.match(activityMismatchRegex)

                if (match) {
                    const [, scheduledEvent, activityCommand] = match
                    const details = {
                        issue: 'Activity Type Mismatch',
                        explanation: `The workflow history expected activity '${scheduledEvent}' but the code attempted to execute '${activityCommand}'`,
                    }

                    this.report.errors.push({
                        workflowId,
                        errorType: 'DeterminismViolation',
                        errorMessage,
                        details,
                    })

                    this.logger.fatal(`❌ Workflow ${workflowId} has determinism issues: Activity type mismatch`, {
                        nondeterminismDetails: details,
                    })
                } else if (errorMessage.includes('WorkflowExecutionCompleted')) {
                    const details = {
                        issue: 'New Steps Added',
                        explanation:
                            'This workflow has been modified to add new steps after the point where it previously completed. This is safe to ignore as it does not affect existing history.',
                    }

                    this.report.warnings.push({
                        workflowId,
                        errorType: 'DeterminismViolation',
                        errorMessage,
                        details,
                    })

                    this.logger.warn(`⚠️ Workflow ${workflowId} has been modified to add new steps`, {
                        details,
                        err,
                    })

                    const lastWorkflow = this.report.checkedWorkflows.at(-1)
                    if (lastWorkflow) {
                        lastWorkflow.status = 'success'
                    }

                    return
                } else {
                    this.report.errors.push({
                        workflowId,
                        errorType: 'DeterminismViolation',
                        errorMessage,
                    })

                    this.logger.error(`❌ Workflow ${workflowId} has determinism issues`, {})
                }
            } else {
                const errorMessage = err instanceof Error ? err.message : String(err)

                this.report.errors.push({
                    workflowId,
                    errorType: 'ReplayFailure',
                    errorMessage,
                })

                this.logger.error(`⚠️ Workflow ${workflowId} replay failed`, { err })
            }

            throw err
        }
    }

    private async loadWorkflows(workflowsPath: string): Promise<WorkflowRecord> {
        const fullWorkflowsPath = this.resolveWorkflowsPath(workflowsPath)

        // eslint-disable-next-line security/detect-non-literal-fs-filename
        const workflowsExist = existsSync(fullWorkflowsPath) // nosemgrep: eslint.detect-non-literal-fs-filename
        if (!workflowsExist) {
            throw new Error(`Workflow files not found under provided path: ${fullWorkflowsPath}`)
        }

        const module = await import(fullWorkflowsPath)
        const workflows = module.default

        if (workflows['interceptors']) {
            delete workflows['interceptors']
        }

        return workflows
    }

    private async listCompletedOrFailedWorkflows(client: TemporalClient, workflowsPath: string): Promise<string[]> {
        const workflowsByType: Record<string, string[]> = {}
        const taskQueue = this.getTaskQueue() || 'default'

        const completedOrFailedWorkflows = client.workflow.list({
            query: `TaskQueue="${taskQueue}" AND (ExecutionStatus="Completed" OR ExecutionStatus="Failed")`,
        })

        for await (const workflow of completedOrFailedWorkflows) {
            const workflowType = workflow.type

            if (!workflowsByType[workflowType]) {
                workflowsByType[workflowType] = []
            }

            if (workflowsByType[workflowType].length < this.maxWorkflowsPerType) {
                workflowsByType[workflowType].push(workflow.workflowId)

                if (workflowsByType[workflowType].length === this.maxWorkflowsPerType) {
                    this.logger.info(`Reached limit of ${this.maxWorkflowsPerType} workflows for type '${workflowType}'`)
                }
            }
        }

        const workflowTypes = Object.keys(workflowsByType)
        const relevantWorkflows = await this.loadWorkflows(workflowsPath)
        const relevantWorkflowTypes = Object.keys(relevantWorkflows)

        const filteredWorkflowsByType: Record<string, string[]> = {}

        for (const [type, workflows] of Object.entries(workflowsByType)) {
            if (relevantWorkflowTypes.includes(type)) {
                filteredWorkflowsByType[type] = workflows
            }
        }

        const filteredWorkflowTypes = Object.keys(filteredWorkflowsByType)
        const excludedCount = workflowTypes.length - filteredWorkflowTypes.length

        this.logger.info(`Found workflows of ${filteredWorkflowTypes.length} relevant types: ${filteredWorkflowTypes.join(', ')}`)

        if (excludedCount > 0) {
            const excludedTypes = workflowTypes.filter((type) => !relevantWorkflowTypes.includes(type))

            this.logger.info(`🚫 Excluded ${excludedCount} workflow types which are missing in codebase: ${excludedTypes.join(', ')}`)
        }

        return Object.values(filteredWorkflowsByType).flat()
    }

    private resolveWorkflowsPath(workflowsPath: string): string {
        const baseDir = path.resolve('./dist')
        const fullPath = path.resolve(baseDir, workflowsPath, 'index.js')

        if (!fullPath.startsWith(baseDir + path.sep)) {
            throw new Error(`Invalid workflows path: path traversal detected in '${workflowsPath}'`)
        }

        return fullPath
    }

    private getTaskQueue(): string | undefined {
        const taskQueue = EnvService.getVar('TEMPORAL_TASK_QUEUE', 'string', '')

        if (!taskQueue) {
            return utils.getServiceName()
        }

        return taskQueue
    }

    private printBeautifulResults(): void {
        const reset = '\u001B[0m'
        const bold = '\u001B[1m'
        const green = '\u001B[32m'
        const red = '\u001B[31m'
        const yellow = '\u001B[33m'
        const magenta = '\u001B[35m'
        const cyan = '\u001B[36m'
        const white = '\u001B[37m'
        const bgBlue = '\u001B[44m'
        const bgRed = '\u001B[41m'
        const bgGreen = '\u001B[42m'
        const bgYellow = '\u001B[43m'
        const dim = '\u001B[2m'
        const underline = '\u001B[4m'

        stdout.write('\n\n')
        stdout.write(`  ${bgBlue}${bold}${white} WORKFLOW DETERMINISM CHECK RESULTS ${reset}\n\n`)

        if (this.report.errors.length > 0) {
            stdout.write(`  ${bold}${red}${underline}Errors${reset}\n\n`)

            for (const [index, error] of this.report.errors.entries()) {
                const errorTypeColor = error.errorType === 'DeterminismViolation' ? red : yellow
                const errorBg = error.errorType === 'DeterminismViolation' ? bgRed : bgYellow

                stdout.write(
                    `  ${errorBg}${white}${bold} Error #${index + 1} ${reset} ${errorTypeColor}${bold}${error.errorType}${reset}\n\n`,
                )
                stdout.write(`    ${bold}Workflow ID:${reset} ${cyan}${error.workflowId}${reset}\n`)
                stdout.write(`    ${bold}Message:${reset} ${errorTypeColor}${error.errorMessage}${reset}\n`)

                if (error.details) {
                    stdout.write(`\n    ${bold}${underline}Details:${reset}\n`)
                    for (const [key, value] of Object.entries(error.details)) {
                        const formattedValue = typeof value === 'string' ? value : format('%o', value)

                        stdout.write(`      ${magenta}${key}:${reset} ${formattedValue}\n`)
                    }
                }

                if (index < this.report.errors.length - 1) {
                    stdout.write(`\n  ${dim}${'─'.repeat(60)}${reset}\n\n`)
                }
            }
        }

        if (this.report.warnings.length > 0) {
            stdout.write(`\n  ${bold}${yellow}${underline}Warnings${reset}\n\n`)

            for (const [index, warning] of this.report.warnings.entries()) {
                const errorBg = bgYellow
                const errorTypeColor = yellow

                stdout.write(
                    `  ${errorBg}${white}${bold} Warning #${index + 1} ${reset} ${errorTypeColor}${bold}${warning.errorType}${reset}\n\n`,
                )
                stdout.write(`    ${bold}Workflow ID:${reset} ${cyan}${warning.workflowId}${reset}\n`)
                stdout.write(`    ${bold}Message:${reset} ${errorTypeColor}${warning.errorMessage}${reset}\n`)

                if (warning.details) {
                    stdout.write(`\n    ${bold}${underline}Details:${reset}\n`)
                    for (const [key, value] of Object.entries(warning.details)) {
                        const formattedValue = typeof value === 'string' ? value : format('%o', value)

                        stdout.write(`      ${magenta}${key}:${reset} ${formattedValue}\n`)
                    }
                }

                if (index < this.report.warnings.length - 1) {
                    stdout.write(`\n  ${dim}${'─'.repeat(60)}${reset}\n\n`)
                }
            }
        }

        if (this.report.checkedWorkflows.length > 0) {
            stdout.write(`\n  ${bold}${underline}Checked Workflow Types${reset}\n\n`)

            const workflowTypeMap = new Map<string, { status: 'success' | 'failure'; totalCount: number; failingCount: number }>()

            for (const workflow of this.report.checkedWorkflows) {
                if (workflowTypeMap.has(workflow.name)) {
                    const entry = workflowTypeMap.get(workflow.name)!

                    entry.totalCount++

                    if (workflow.status === 'failure') {
                        entry.status = 'failure'
                        entry.failingCount++
                    }
                } else {
                    workflowTypeMap.set(workflow.name, {
                        status: workflow.status,
                        totalCount: 1,
                        failingCount: workflow.status === 'failure' ? 1 : 0,
                    })
                }
            }

            const sortedTypes = Array.from(workflowTypeMap.entries()).toSorted((a, b) => a[0].localeCompare(b[0]))

            const deterministic = sortedTypes.filter(([, data]) => data.status === 'success')
            if (deterministic.length > 0) {
                stdout.write(`  ${bgGreen}${white}${bold} DETERMINISTIC WORKFLOW TYPES ${reset}\n\n`)
                for (const [name, data] of deterministic) {
                    stdout.write(
                        `    ${green}✓${reset} ${bold}${name}${reset} (${data.totalCount} instance${data.totalCount === 1 ? '' : 's'})\n`,
                    )
                }

                stdout.write('\n')
            }

            const nonDeterministic = sortedTypes.filter(([, data]) => data.status === 'failure')
            if (nonDeterministic.length > 0) {
                stdout.write(`  ${bgRed}${white}${bold} NON-DETERMINISTIC WORKFLOW TYPES ${reset}\n\n`)
                for (const [name, data] of nonDeterministic) {
                    stdout.write(
                        `    ${red}✗${reset} ${bold}${name}${reset} (${data.failingCount} failing instance${data.failingCount === 1 ? '' : 's'} out of ${data.totalCount})\n`,
                    )
                }

                stdout.write('\n')
            }
        }

        stdout.write('\n')

        stdout.write(`  ${bold}${underline}Summary${reset}\n\n`)
        stdout.write(
            `    ${green}✓ ${bold}Passed:${reset}  ${this.report.successCount > 0 ? green : dim}${this.report.successCount}${reset}\n`,
        )
        stdout.write(`    ${red}✗ ${bold}Failed:${reset}  ${this.report.failureCount > 0 ? red : dim}${this.report.failureCount}${reset}\n`)

        const total = this.report.successCount + this.report.failureCount

        stdout.write(`    ${bold}Total:${reset}   ${total > 0 ? bold : dim}${total}${reset}\n\n`)

        if (this.report.failureCount === 0 && this.report.successCount > 0) {
            stdout.write(`  ${bgGreen}${white}${bold} SUCCESS ${reset} ${green}All workflows are deterministic!${reset}\n\n`)
        } else if (this.report.failureCount > 0) {
            stdout.write(`  ${bgRed}${white}${bold} FAILURE ${reset} ${red}Some workflows have determinism issues!${reset}\n\n`)
        } else {
            stdout.write(`  ${bgYellow}${white}${bold} INFO ${reset} ${yellow}No workflows were checked.${reset}\n\n`)
        }

        stdout.write('\n')

        this.logger.info(`Workflow determinism check results: ${this.report.successCount} passed, ${this.report.failureCount} failed`)
    }
}
