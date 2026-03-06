import DiiaLogger from '@diia-inhouse/diia-logger'
import { EnvService, ProcessedTransitKey } from '@diia-inhouse/env'

import { getDataConverter } from '../../../src/encryption/dataConverter'
import { EncryptionCodec } from '../../../src/encryption/encryptionCodec'

class MockEnvService extends EnvService {
    async getTransitKey(): Promise<ProcessedTransitKey> {
        return {
            key: '1C1zF0L0u0szACsu9VEb1aNYoXccVs1xg3PdqifaRxM=',
            fullKeyName: 'transit/export/encryption-key/key/2',
        }
    }
}

describe('dataConverter', () => {
    let mockEnvService: MockEnvService
    const keyId = 'test-key-path'

    beforeAll(() => {
        process.env.TEMPORAL_ENCRYPTION_KEY_ID = keyId
        process.env.VAULT_ENABLED = 'true'
        process.env.VAULT_ADDR = 'http://localhost:8200'
    })

    beforeEach(() => {
        mockEnvService = new MockEnvService(new DiiaLogger())
    })

    afterAll(() => {
        delete process.env.TEMPORAL_ENCRYPTION_KEY_ID
        vi.restoreAllMocks()
    })

    describe('getDataConverter', () => {
        it('should return a DataConverter with EncryptionCodec', async () => {
            // Act
            const dataConverter = await getDataConverter(keyId, mockEnvService)

            // Assert
            expect(dataConverter).toBeDefined()
            expect(dataConverter).toHaveProperty('payloadCodecs')
            expect(dataConverter.payloadCodecs?.length).toBe(1)
            expect(dataConverter.payloadCodecs?.[0]).toBeInstanceOf(EncryptionCodec)
        })

        it('should cache the DataConverter instance', async () => {
            // Act
            const dataConverter1 = await getDataConverter(keyId, mockEnvService)
            const dataConverter2 = await getDataConverter(keyId, mockEnvService)

            // Assert
            expect(dataConverter1).toBe(dataConverter2)
        })
    })
})
