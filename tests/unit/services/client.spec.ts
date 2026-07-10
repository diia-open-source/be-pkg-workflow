import { describe, expect, it } from 'vitest'

import type { EnvService } from '@diia-inhouse/env'
import type { Logger } from '@diia-inhouse/types'

import type { Client } from '../../../src/client'
import type { TemporalConfig } from '../../../src/interfaces/config'
import { TemporalClient } from '../../../src/services/client'

interface ClientFixture {
    client: TemporalClient
    nativeClient: Record<string, unknown>
}

describe('TemporalClient getters', () => {
    const config = { taskQueue: 'tq', encryptionEnabled: false, encryptionKeyId: '' } as TemporalConfig

    function buildClient(): ClientFixture {
        const client = new TemporalClient(config, {} as EnvService, {} as Logger)
        const nativeClient = {
            activity: { kind: 'activity' },
            workflow: { kind: 'workflow' },
            schedule: { kind: 'schedule' },
            taskQueue: { kind: 'taskQueue' },
            connection: { kind: 'connection' },
            workflowService: { kind: 'workflowService' },
        }

        client.nativeClient = nativeClient as unknown as Client

        return { client, nativeClient }
    }

    it('exposes the standalone-activity client via the activity getter', () => {
        const { client, nativeClient } = buildClient()

        expect(client.activity).toBe(nativeClient.activity)
    })

    it('delegates the remaining getters to nativeClient', () => {
        const { client, nativeClient } = buildClient()

        expect(client.workflow).toBe(nativeClient.workflow)
        expect(client.schedule).toBe(nativeClient.schedule)
        expect(client.taskQueue).toBe(nativeClient.taskQueue)
        expect(client.connection).toBe(nativeClient.connection)
        expect(client.workflowService).toBe(nativeClient.workflowService)
    })
})
