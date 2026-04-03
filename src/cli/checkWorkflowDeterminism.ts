/* eslint-disable unicorn/no-process-exit */
import { existsSync } from 'node:fs'

import { Runtime } from '@temporalio/worker'
import { register } from 'ts-node'

import { EnvService } from '@diia-inhouse/env'
import { Logger } from '@diia-inhouse/types'
import { utils } from '@diia-inhouse/utils'

import { TemporalConfig } from '../interfaces'
import { TemporalClient } from '../services/client'
import {
    DeterminismReportBuilder,
    buildReplayOptions,
    isNewStepsAdded,
    loadHistoryEntries,
    printReport,
    replayBatch,
    replaySingle,
    resolveWorkflowsPath,
} from './determinism'
import { WorkflowRecord } from './determinism/types'

register()

export class CheckWorkflowDeterminismCommand {
    private readonly maxWorkflowsPerType = 10
    private readonly maxRetries = 3
    private readonly retryDelayMs = 500
    private readonly replayTimeoutMs = 30_000
    private readonly delayBetweenWorkflows = 100

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

        const temporalConfig: TemporalConfig = {
            address: EnvService.getVar('TEMPORAL_ADDRESS'),
            namespace: EnvService.getVar('TEMPORAL_NAMESPACE', 'string', 'default'),
            taskQueue,
            encryptionEnabled: EnvService.getVar('TEMPORAL_ENCRYPTION_ENABLED', 'boolean', false),
            encryptionKeyId: EnvService.getVar('TEMPORAL_ENCRYPTION_KEY_ID', 'string', ''),
        }

        const client = new TemporalClient(temporalConfig, this.envService, this.logger)

        await client.onInit()

        try {
            const report = await this.checkFromServer(client, workflowsPath, temporalConfig, workflowId)

            this.logger.info(`Workflow determinism check finished! It took ${((Date.now() - startTime) / 1000).toFixed(1)} seconds`)

            printReport(report)
            this.logger.info(`Workflow determinism check results: ${report.successCount} passed, ${report.failureCount} failed`)

            if (report.failureCount > 0) {
                this.logger.error(`Determinism check failed: ${report.failureCount} workflows have determinism issues`)
                process.exit(1)
            }
        } finally {
            await client.nativeClient.connection.close()
        }

        process.exit(0)
    }

    async runFromFiles(workflowsPath = 'worker/workflows', historyDir: string, limit?: number): Promise<void> {
        const startTime = Date.now()

        Runtime.install({ logger: this.logger })

        this.logger.info('Starting workflow determinism check from local files', { workflowsPath, historyDir, limit })

        const workflows = await this.loadWorkflows(workflowsPath)

        this.logger.info(`Found ${Object.keys(workflows).length} workflows`, { workflows: Object.keys(workflows) })

        const encryption = {
            enabled: EnvService.getVar('TEMPORAL_ENCRYPTION_ENABLED', 'boolean', false),
            keyId: EnvService.getVar('TEMPORAL_ENCRYPTION_KEY_ID', 'string', ''),
        }

        const { entries, encryptedCount, runningCount } = loadHistoryEntries(historyDir, workflows, {
            limit,
            encryptionEnabled: encryption.enabled,
            logger: this.logger,
        })

        this.logger.info(`Loaded ${entries.length} valid histories${limit ? ` (limited to ${limit})` : ''}`)

        if (runningCount > 0) {
            this.logger.info(`Skipped ${runningCount} running workflow(s) — only completed/failed workflows are checked`)
        }

        if (encryptedCount > 0) {
            this.logger.warn(
                `⚠️ Skipped ${encryptedCount} encrypted file(s) — set TEMPORAL_ENCRYPTION_ENABLED=true and provide encryption keys`,
            )
        }

        if (entries.length === 0) {
            this.logger.info('No history files found')
            process.exit(0)
        }

        const options = await buildReplayOptions(workflowsPath, encryption, this.envService)
        const reportBuilder = new DeterminismReportBuilder()

        reportBuilder.setSkippedCount(encryptedCount)

        this.logger.info(`Replaying ${entries.length} workflows...`)

        let processed = 0

        try {
            for await (const outcome of replayBatch(options, entries)) {
                processed++

                switch (outcome.status) {
                    case 'success': {
                        reportBuilder.addSuccess(outcome.workflowId, outcome.workflowType)
                        this.logger.info(`✅ Workflow ${outcome.workflowId} (${outcome.workflowType}) is deterministic`)
                        break
                    }
                    case 'failure': {
                        if (isNewStepsAdded(outcome.error)) {
                            reportBuilder.addSuccess(outcome.workflowId, outcome.workflowType)
                            reportBuilder.addWarning(outcome.error)
                            this.logger.warn(
                                `⚠️ Workflow ${outcome.workflowId} (${outcome.workflowType}) has been modified to add new steps`,
                            )
                        } else {
                            reportBuilder.addFailure(outcome.workflowId, outcome.workflowType, outcome.error)
                            this.logger.error(`❌ Workflow ${outcome.workflowId} (${outcome.workflowType}): ${outcome.error.errorMessage}`)
                        }

                        break
                    }
                    case 'timeout': {
                        reportBuilder.addTimeout(outcome.workflowId, outcome.workflowType, {
                            workflowId: outcome.workflowId,
                            errorType: 'ReplayFailure',
                            errorMessage: `Replay timed out after ${outcome.timeoutMs / 1000}s`,
                        })
                        this.logger.warn(`⏰ Workflow ${outcome.workflowId} timed out`)
                        break
                    }
                }

                if (processed % 50 === 0) {
                    const report = reportBuilder.build()

                    this.logger.info(
                        `Progress: ${processed}/${entries.length} (${report.successCount} passed, ${report.failureCount} failed)`,
                    )
                }
            }
        } catch (err) {
            this.logger.error(`Replay stream stopped at ${processed}/${entries.length}: ${(err as Error).message}`)
        }

        const report = reportBuilder.build()

        printReport(report)
        this.logger.info(`Determinism check from files finished in ${((Date.now() - startTime) / 1000).toFixed(1)} seconds`)
        this.logger.info(`Workflow determinism check results: ${report.successCount} passed, ${report.failureCount} failed`)

        if (report.failureCount > 0) {
            this.logger.error(`Determinism check failed: ${report.failureCount} workflows have determinism issues`)
            process.exit(1)
        }

        process.exit(0)
    }

    private async checkFromServer(
        client: TemporalClient,
        workflowsPath: string,
        temporalConfig: TemporalConfig,
        specificWorkflowId?: string,
    ): Promise<import('./determinism').DeterminismReport> {
        const reportBuilder = new DeterminismReportBuilder()

        try {
            const workflowIds = specificWorkflowId ? [specificWorkflowId] : await this.listCompletedOrFailedWorkflows(client, workflowsPath)

            if (workflowIds.length === 0) {
                this.logger.info('No completed or failed workflows found to check')

                return reportBuilder.build()
            }

            if (!specificWorkflowId) {
                this.logger.info(
                    `Found ${workflowIds.length} completed or failed workflows to check (limited to max ${this.maxWorkflowsPerType} per workflow type)`,
                )
            }

            const options = await buildReplayOptions(
                workflowsPath,
                {
                    enabled: temporalConfig.encryptionEnabled,
                    keyId: temporalConfig.encryptionKeyId,
                },
                this.envService,
            )

            for (const [i, workflowId] of workflowIds.entries()) {
                if (i > 0) {
                    await new Promise((resolve) => setTimeout(resolve, this.delayBetweenWorkflows))
                }

                await this.checkSingleWorkflow(client, options, workflowId, reportBuilder)
            }
        } catch (err) {
            this.logger.error('❌ Failed to check workflow determinism', { err })
            throw err
        }

        return reportBuilder.build()
    }

    private async checkSingleWorkflow(
        client: TemporalClient,
        options: import('@temporalio/worker').ReplayWorkerOptions,
        workflowId: string,
        reportBuilder: DeterminismReportBuilder,
    ): Promise<void> {
        this.logger.info(`Checking workflow ${workflowId}`)

        const handle = client.workflow.getHandle(workflowId)
        const history = await handle.fetchHistory()
        const description = await handle.describe()
        const workflowName = description.type

        const outcome = await replaySingle(options, history, workflowId, workflowName, {
            maxRetries: this.maxRetries,
            retryDelayMs: this.retryDelayMs,
            timeoutMs: this.replayTimeoutMs,
        })

        switch (outcome.status) {
            case 'success': {
                this.logger.info(`✅ Workflow ${workflowId} is deterministic`)

                if (outcome.recoveredOnRetry) {
                    reportBuilder.addWarning({
                        workflowId,
                        errorType: 'ReplayFailure',
                        errorMessage: `Workflow failed ${outcome.failedAttempts} time(s) but recovered on retry`,
                        details: {
                            issue: 'Workflow Recovered on Retry',
                            explanation: `This workflow initially failed replay but succeeded after ${outcome.failedAttempts} failed attempt(s). This may indicate transient issues or race conditions.`,
                            failedAttempts: outcome.failedAttempts,
                            originalErrors: outcome.originalErrors,
                        },
                    })
                    this.logger.warn(`⚠️ Workflow ${workflowId} recovered after ${outcome.failedAttempts} failed attempt(s)`)
                }

                reportBuilder.addSuccess(workflowId, workflowName)
                break
            }
            case 'failure': {
                if (isNewStepsAdded(outcome.error)) {
                    reportBuilder.addSuccess(workflowId, workflowName)
                    reportBuilder.addWarning(outcome.error)
                    this.logger.warn(`⚠️ Workflow ${workflowId} has been modified to add new steps`)
                } else {
                    reportBuilder.addFailure(workflowId, workflowName, outcome.error)
                    this.logger.error(`❌ Workflow ${workflowId} has determinism issues`)
                }

                break
            }
            case 'timeout': {
                reportBuilder.addTimeout(workflowId, workflowName, {
                    workflowId,
                    errorType: 'ReplayFailure',
                    errorMessage: `Replay timed out after ${outcome.timeoutMs / 1000}s`,
                    details: {
                        issue: 'Replay Timeout',
                        explanation: `Replay did not complete within ${outcome.timeoutMs / 1000}s. This may indicate a stuck workflow.`,
                    },
                })
                this.logger.warn(`⏰ Workflow ${workflowId} timed out after ${outcome.timeoutMs / 1000}s — skipping`)
                break
            }
        }
    }

    private async loadWorkflows(workflowsPath: string): Promise<WorkflowRecord> {
        const fullWorkflowsPath = resolveWorkflowsPath(workflowsPath)

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
        const taskQueue = this.getTaskQueue() || 'default'
        const relevantWorkflows = await this.loadWorkflows(workflowsPath)
        const relevantWorkflowTypes = Object.keys(relevantWorkflows)

        const workflowIds: string[] = []
        const typesWithWorkflows: string[] = []

        for (const workflowType of relevantWorkflowTypes) {
            const workflows = client.workflow.list({
                query: `TaskQueue="${taskQueue}" AND WorkflowType="${workflowType}" AND (ExecutionStatus="Completed" OR ExecutionStatus="Failed")`,
                pageSize: this.maxWorkflowsPerType,
            })

            let count = 0

            for await (const workflow of workflows) {
                workflowIds.push(workflow.workflowId)
                count++

                if (count >= this.maxWorkflowsPerType) {
                    break
                }
            }

            if (count > 0) {
                typesWithWorkflows.push(workflowType)
            }
        }

        this.logger.info(`Found workflows of ${typesWithWorkflows.length} relevant types: ${typesWithWorkflows.join(', ')}`)

        return workflowIds
    }

    private getTaskQueue(): string | undefined {
        const taskQueue = EnvService.getVar('TEMPORAL_TASK_QUEUE', 'string', '')

        if (!taskQueue) {
            return utils.getServiceName()
        }

        return taskQueue
    }
}
