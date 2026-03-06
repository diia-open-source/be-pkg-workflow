#!/usr/bin/env node
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'

import DiiaLogger from '@diia-inhouse/diia-logger'
import { EnvService } from '@diia-inhouse/env'

import { CheckWorkflowDeterminismCommand } from './checkWorkflowDeterminism'
import { SyncTemporalSchedulesCommand } from './syncTemporalSchedules'
import { UpdateTemporalScheduleCommand } from './updateTemporalSchedule'

async function main(): Promise<void> {
    await yargs(hideBin(process.argv))
        .command(
            'sync-schedules',
            'Sync schedules with Temporal server',
            (args) =>
                args
                    .option('schedulesPath', {
                        type: 'string',
                        default: 'worker/schedules',
                        describe: 'Path to schedules directory',
                    })
                    .option('taskQueue', {
                        type: 'string',
                        describe: 'Task queue name',
                    }),
            async (argv) => {
                const logger = new DiiaLogger()
                const envService = new EnvService(logger)

                await envService.init()
                try {
                    const command = new SyncTemporalSchedulesCommand(logger, envService)

                    await command.run(argv.schedulesPath, argv.taskQueue)
                } finally {
                    await envService.onDestroy()
                }
            },
        )
        .command(
            'update-schedule <scheduleId> <updateJson>',
            'Update a temporal schedule',
            (args) =>
                args
                    .positional('scheduleId', {
                        type: 'string',
                        describe: 'ID of the schedule to update',
                    })
                    .positional('updateJson', {
                        type: 'string',
                        describe: 'JSON object containing fields to update',
                    })
                    .example(
                        'diia-workflow update-schedule my-schedule \'{"spec": {"intervals": [{"every": "300s"}]}}\'',
                        'Change a schedule to run every 5 minutes',
                    )
                    .example('diia-workflow update-schedule my-schedule \'{"state": {"paused": true}}\'', 'Pause a schedule')
                    .example('diia-workflow update-schedule my-schedule \'{"state": {"paused": false}}\'', 'Resume a paused schedule')
                    .example(
                        'diia-workflow update-schedule my-schedule \'{"action": {"args": [{"param": "new-arg1"}]}}\'',
                        'Update the arguments passed to the workflow',
                    )
                    .example(
                        'diia-workflow update-schedule my-schedule \'{\n  "spec": {"intervals": [{"every": "600s"}]},\n  "state": {"paused": false},\n  "action": {"args": [{"param": "new-arg1"}]}\n}\'',
                        'Update multiple fields in a single command',
                    ),
            async (argv) => {
                if (!argv.scheduleId) {
                    throw new Error('scheduleId is required')
                }

                if (!argv.updateJson) {
                    throw new Error('updateJson is required')
                }

                let updateData: Record<string, unknown>
                try {
                    updateData = JSON.parse(argv.updateJson)
                    if (typeof updateData !== 'object' || updateData === null) {
                        throw new Error('Update data must be a valid JSON object')
                    }
                } catch (err) {
                    throw new Error(`Invalid JSON format. Please provide a valid JSON object. Error: ${(err as Error).message}`)
                }

                if (Object.keys(updateData).length === 0) {
                    throw new Error('Update data cannot be empty')
                }

                const logger = new DiiaLogger()
                const envService = new EnvService(logger)

                await envService.init()
                try {
                    const command = new UpdateTemporalScheduleCommand(logger, envService)

                    await command.run(argv.scheduleId, updateData)
                } finally {
                    await envService.onDestroy()
                }
            },
        )
        .command(
            'check-determinism [workflowId]',
            'Check completed or failed workflows for determinism issues',
            (args) =>
                args
                    .option('workflowsPath', {
                        type: 'string',
                        default: 'worker/workflows',
                        describe: 'Path to workflows directory',
                    })
                    .option('taskQueue', {
                        type: 'string',
                        describe: 'Task queue name',
                    })
                    .positional('workflowId', {
                        type: 'string',
                        describe: 'Specific workflow ID to check (optional)',
                    })
                    .example('diia-workflow check-determinism', 'Check recent completed or failed workflows for determinism issues')
                    .example('diia-workflow check-determinism my-workflow-id', 'Check a specific workflow by ID for determinism issues'),
            async (argv) => {
                const logger = new DiiaLogger()
                const envService = new EnvService(logger)

                await envService.init()
                try {
                    const command = new CheckWorkflowDeterminismCommand(logger, envService)

                    await command.run(argv.workflowsPath, argv.taskQueue, argv.workflowId)
                } finally {
                    await envService.onDestroy()
                }
            },
        )
        .help().argv
}

void main()
