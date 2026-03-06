import {
    Client,
    ClientInterceptors,
    Connection,
    ScheduleDescription,
    ScheduleOptions,
    ScheduleSummary,
    ScheduleUpdateOptions,
} from '@temporalio/client'
import { OpenTelemetryWorkflowClientInterceptor } from '@temporalio/interceptors-opentelemetry/lib/client'
import { merge } from 'lodash'

import { EnvService } from '@diia-inhouse/env'
import { Logger, OnInit } from '@diia-inhouse/types'

import { getDataConverter } from '../encryption/dataConverter'
import { TemporalConfig } from '../interfaces/config'

export class TemporalClient implements OnInit {
    nativeClient!: Client

    private readonly defaultTimezone = 'Europe/Kyiv'

    constructor(
        private readonly config: TemporalConfig,
        private readonly envService: EnvService,
        private readonly logger: Logger,
    ) {}

    get connection(): Client['connection'] {
        return this.nativeClient.connection
    }

    get workflow(): Client['workflow'] {
        return this.nativeClient.workflow
    }

    get workflowService(): Client['workflowService'] {
        return this.nativeClient.workflowService
    }

    get schedule(): Client['schedule'] {
        return this.nativeClient.schedule
    }

    get taskQueue(): Client['taskQueue'] {
        return this.nativeClient.taskQueue
    }

    async onInit(): Promise<void> {
        const { address, tls, connectTimeout, encryptionEnabled, encryptionKeyId, encryptionKeyRefreshInterval, ...clientConfig } =
            this.config

        const connection = await Connection.connect({ address, tls, connectTimeout }).catch((err) => {
            this.logger.error('Failed to connect to Temporal', { err })

            throw new Error('Failed to connect to Temporal', { cause: err })
        })

        const dataConverter = encryptionEnabled
            ? await getDataConverter(encryptionKeyId, this.envService, encryptionKeyRefreshInterval)
            : undefined

        const interceptors: ClientInterceptors | undefined = EnvService.getVar('TRACING_ENABLED', 'boolean', false)
            ? { workflow: [new OpenTelemetryWorkflowClientInterceptor()] }
            : undefined

        this.nativeClient = new Client({ ...clientConfig, connection, dataConverter, interceptors })
    }

    async syncSchedules(schedules: Record<string, ((config: TemporalConfig) => ScheduleOptions) | ScheduleOptions>): Promise<void> {
        const applicationSchedules = Object.entries(schedules).map(([, schedule]) =>
            typeof schedule === 'function' ? schedule(this.config) : schedule,
        )

        const temporalSchedules: ScheduleSummary[] = []
        for await (const schedule of this.schedule.list()) {
            if (schedule.memo?.TaskQueue === this.config.taskQueue) {
                temporalSchedules.push(schedule)
            }
        }

        const schedulesToCreate = applicationSchedules.filter(
            (scheduleOptions) => !temporalSchedules.some((schedule) => schedule.scheduleId === scheduleOptions.scheduleId),
        )

        for (const scheduleOptions of schedulesToCreate) {
            scheduleOptions.memo = {
                ...scheduleOptions.memo,
                TaskQueue: scheduleOptions.action.taskQueue,
            }

            if (!scheduleOptions.spec.timezone) {
                scheduleOptions.spec.timezone = this.defaultTimezone
            }

            await this.schedule.create(scheduleOptions)
        }

        if (schedulesToCreate.length > 0) {
            this.logger.info(
                `Schedules created (${schedulesToCreate.length}): ${schedulesToCreate.map((schedule) => schedule.scheduleId).join(', ')}`,
            )
        }

        const schedulesToDelete = temporalSchedules.filter(
            (schedule) => !applicationSchedules.some((scheduleOptions) => scheduleOptions.scheduleId === schedule.scheduleId),
        )

        for (const schedule of schedulesToDelete) {
            const handle = this.schedule.getHandle(schedule.scheduleId)

            await handle.delete()
        }

        if (schedulesToDelete.length > 0) {
            this.logger.info(
                `Schedules deleted (${schedulesToDelete.length}): ${schedulesToDelete.map((schedule) => schedule.scheduleId).join(', ')}`,
            )
        }
    }

    async updateSchedule(scheduleId: string, updateData: ScheduleUpdateOptions): Promise<void> {
        try {
            const scheduleHandle = this.schedule.getHandle(scheduleId)

            this.logger.info('Schedule update details:', { scheduleId, updateData })

            await scheduleHandle.update((previous: ScheduleDescription): ScheduleUpdateOptions => {
                return merge(previous, updateData)
            })
            this.logger.info('Successfully updated temporal schedule', { scheduleId })
        } catch (err) {
            this.logger.error('Failed to update temporal schedule', { err })
            throw err
        }
    }
}
