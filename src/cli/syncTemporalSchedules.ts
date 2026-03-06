import { existsSync } from 'node:fs'
import path from 'node:path'

import { ScheduleAlreadyRunning, ScheduleOptions } from '@temporalio/client'
import { register } from 'ts-node'

import { EnvService } from '@diia-inhouse/env'
import { Logger } from '@diia-inhouse/types'
import { utils } from '@diia-inhouse/utils'

import { TemporalConfig } from '../interfaces/config'
import { TemporalClient } from '../services/client'

register()

export class SyncTemporalSchedulesCommand {
    constructor(
        private readonly logger: Logger,
        private readonly envService: EnvService,
    ) {}

    async run(schedulesPath = 'worker/schedules', taskQueueParam?: string): Promise<void> {
        const startTime = Date.now()

        this.logger.info('Starting sync temporal schedules', { schedulesPath, taskQueue: taskQueueParam })

        const schedules = await this.loadSchedules(schedulesPath)
        if (!schedules) {
            this.logger.info('Temporal schedules not found under provided path', { schedulesPath })

            return
        }

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

        await this.syncSchedules(client, schedules)

        this.logger.info(`Sync temporal schedules finished! It took ${((Date.now() - startTime) / 1000).toFixed(1)} seconds`)

        await client.nativeClient.connection.close()

        // eslint-disable-next-line unicorn/no-process-exit
        process.exit(0)
    }

    private async loadSchedules(
        schedulesPath: string,
    ): Promise<Record<string, ((config: TemporalConfig) => ScheduleOptions) | ScheduleOptions> | undefined> {
        const fullSchedulesPath = this.resolveSchedulesPath(schedulesPath)

        // eslint-disable-next-line security/detect-non-literal-fs-filename
        const schedulesExist = existsSync(fullSchedulesPath) // nosemgrep: eslint.detect-non-literal-fs-filename
        if (!schedulesExist) {
            return
        }

        const module = await import(fullSchedulesPath)

        return module.default
    }

    private resolveSchedulesPath(schedulesPath: string): string {
        const baseDir = path.resolve('./dist')
        const fullPath = path.resolve(baseDir, schedulesPath, 'index.js')

        if (!fullPath.startsWith(baseDir + path.sep)) {
            throw new Error(`Invalid schedules path: path traversal detected in '${schedulesPath}'`)
        }

        return fullPath
    }

    private async syncSchedules(
        client: TemporalClient,
        schedules: Record<string, ((config: TemporalConfig) => ScheduleOptions) | ScheduleOptions>,
    ): Promise<void> {
        try {
            const scheduleNames = Object.keys(schedules)

            this.logger.info(`Found ${scheduleNames.length} schedules to sync: ${scheduleNames.join(', ')}`)

            await client.syncSchedules(schedules)

            this.logger.info('Successfully synced temporal schedules')
        } catch (err) {
            if (err instanceof ScheduleAlreadyRunning) {
                this.logger.info('Schedule already running, skipping creation')

                return
            }

            this.logger.error('Failed to sync temporal schedules', { err })
            throw err
        }
    }

    private getTaskQueue(): string | undefined {
        const taskQueue = EnvService.getVar('TEMPORAL_TASK_QUEUE', 'string', '')

        if (!taskQueue) {
            return utils.getServiceName()
        }

        return taskQueue
    }
}
