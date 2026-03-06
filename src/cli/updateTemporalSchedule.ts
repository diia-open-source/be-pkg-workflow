import { ScheduleUpdateOptions } from '@temporalio/client'

import { EnvService } from '@diia-inhouse/env'
import { Logger } from '@diia-inhouse/types'
import { utils } from '@diia-inhouse/utils'

import { TemporalConfig } from '../interfaces/config'
import { TemporalClient } from '../services/client'

export class UpdateTemporalScheduleCommand {
    constructor(
        private readonly logger: Logger,
        private readonly envService: EnvService,
    ) {}

    async run(scheduleId: string, updateData: Record<string, unknown>): Promise<void> {
        const startTime = Date.now()

        this.logger.info('Starting update temporal schedule', { scheduleId })

        const taskQueue = this.getTaskQueue()
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
            await client.updateSchedule(scheduleId, updateData as ScheduleUpdateOptions)
        } catch (err) {
            this.logger.error('Failed to update temporal schedule', { err })
            throw err
        } finally {
            await client.nativeClient.connection.close()
        }

        this.logger.info(`Update temporal schedule finished! It took ${((Date.now() - startTime) / 1000).toFixed(1)} seconds`)

        // eslint-disable-next-line unicorn/no-process-exit
        process.exit(0)
    }

    private getTaskQueue(): string | undefined {
        const taskQueue = EnvService.getVar('TEMPORAL_TASK_QUEUE', 'string', '')

        if (!taskQueue) {
            return utils.getServiceName()
        }

        return taskQueue
    }
}
