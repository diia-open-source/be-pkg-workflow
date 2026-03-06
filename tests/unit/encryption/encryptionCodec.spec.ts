import { Payload, ValueError } from '@temporalio/common'
import { encode } from '@temporalio/common/lib/encoding'

import DiiaLogger from '@diia-inhouse/diia-logger'
import { EnvService, ProcessedTransitKey } from '@diia-inhouse/env'

import { EncryptionCodec } from '../../../src/encryption/encryptionCodec'

const key = '1C1zF0L0u0szACsu9VEb1aNYoXccVs1xg3PdqifaRxM='
const key2 = 'Xw5Jm2FFvXlZOB/N7EAjuyzhQ+Rk2p6JlI+wpQXEC/8='

type TestPayload = Payload & {
    metadata: { [key: string]: Uint8Array }
    data: Uint8Array
}

class MockEnvService extends EnvService {
    private keyVersion = 1

    async getTransitKey(keyId: string, options: { keyVersion?: string }): Promise<ProcessedTransitKey> {
        if (options.keyVersion === 'latest') {
            return {
                key: this.keyVersion === 1 ? key : key2,
                fullKeyName: `${keyId}/${this.keyVersion.toString()}`,
            }
        }

        return {
            key: key2,
            fullKeyName: `${keyId}/${2}`,
        }
    }

    setKeyVersion(version: number): void {
        this.keyVersion = version
    }
}

describe('EncryptionCodec', () => {
    describe('with vault enabled', () => {
        const keyId = 'transit/export/encryption-key'
        const keyVersion = '1'
        const keyVersion2 = '2'
        const fullKeyName = `${keyId}/${keyVersion}`
        const fullKeyName2 = `${keyId}/${keyVersion2}`

        let codec: EncryptionCodec
        let mockEnvService: MockEnvService

        beforeAll(async () => {
            process.env.TEMPORAL_ENCRYPTION_KEY_ID = keyId

            mockEnvService = new MockEnvService(new DiiaLogger())

            vi.spyOn(mockEnvService, 'getTransitKey')

            codec = await EncryptionCodec.create(keyId, mockEnvService, { vaultEnabled: true })
        })

        afterAll(() => {
            delete process.env.TEMPORAL_ENCRYPTION_KEY_ID
            vi.restoreAllMocks()
        })

        describe('create', () => {
            it('should create codec instance with environment variables', async () => {
                // Act
                const newEnvService = new MockEnvService(new DiiaLogger())

                vi.spyOn(newEnvService, 'getTransitKey')

                const newCodec = await EncryptionCodec.create(keyId, newEnvService, { vaultEnabled: true })

                // Assert
                expect(newCodec).toBeInstanceOf(EncryptionCodec)
                expect(newEnvService.getTransitKey).toHaveBeenCalled()
            })
        })

        describe('encode', () => {
            it('should encode payload with encryption', async () => {
                // Arrange
                const payload = {
                    metadata: { key: encode('value') },
                    data: encode('test data'),
                }

                // Act
                const [encoded] = await codec.encode([payload])

                // Assert
                expect(encoded.metadata).toEqual(
                    expect.objectContaining({
                        encoding: encode('binary/encrypted'),
                        'encryption-key-id': encode(fullKeyName),
                    }),
                )
                expect(encoded.data).toBeInstanceOf(Uint8Array)
                expect(encoded.data!.length).toBeGreaterThan(0)
            })

            it('should encode multiple payloads', async () => {
                // Arrange
                const payloads: TestPayload[] = [
                    { metadata: { 'key-1': encode('value1') }, data: encode('data1') },
                    { metadata: { 'key-2': encode('value2') }, data: encode('data2') },
                ]

                // Act
                const encoded = await codec.encode(payloads)

                // Assert
                expect(encoded).toHaveLength(2)
                for (const payload of encoded) {
                    expect(payload.metadata).toEqual(
                        expect.objectContaining({
                            encoding: encode('binary/encrypted'),
                            'encryption-key-id': encode(fullKeyName),
                        }),
                    )
                    expect(payload.data).toBeInstanceOf(Uint8Array)
                }
            })
        })

        describe('decode', () => {
            it('should decode encrypted payload', async () => {
                // Arrange
                const originalPayload = {
                    metadata: { key: encode('value') },
                    data: encode('test data'),
                }
                const [encoded] = await codec.encode([originalPayload])

                // Act
                const [decoded] = await codec.decode([encoded])

                // Assert
                expect(decoded.metadata).toEqual(originalPayload.metadata)
                expect(decoded.data).toEqual(originalPayload.data)
            })

            it('should return unencrypted payload as is', async () => {
                // Arrange
                const unencryptedPayload = {
                    metadata: { key: encode('value') },
                    data: encode('test data'),
                }

                // Act
                const [decoded] = await codec.decode([unencryptedPayload])

                // Assert
                expect(decoded).toEqual(unencryptedPayload)
            })

            it('should throw error when payload data is missing', async () => {
                // Arrange
                const invalidPayload = {
                    metadata: {
                        encoding: encode('binary/encrypted'),
                        'encryption-key-id': encode(fullKeyName),
                    },
                }

                // Act & Assert
                await expect(codec.decode([invalidPayload])).rejects.toThrow(new ValueError('Payload data is missing'))
            })
        })

        it('should throw error when encryption key id is missing', async () => {
            // Arrange
            const invalidPayload = {
                metadata: {
                    encoding: encode('binary/encrypted'),
                },
                data: new Uint8Array([1, 2, 3]),
            }

            // Act & Assert
            await expect(codec.decode([invalidPayload])).rejects.toThrow(
                new ValueError('Unable to decrypt Payload without encryption key id'),
            )
        })

        describe('refreshDefaultKey', () => {
            it('should refresh the default key with latest version from vault', async () => {
                // Arrange
                const getTransitKeySpy = vi.spyOn(mockEnvService, 'getTransitKey').mockClear()

                mockEnvService.setKeyVersion(2)

                // Act
                await codec.refreshDefaultKey()

                // Assert
                expect(getTransitKeySpy).toHaveBeenCalledWith(keyId, { keyVersion: 'latest' })

                const payload = { metadata: { test: encode('value') }, data: encode('test data') }
                const [encoded] = await codec.encode([payload])

                expect(encoded.metadata).toEqual(
                    expect.objectContaining({
                        encoding: encode('binary/encrypted'),
                        'encryption-key-id': encode(fullKeyName2),
                    }),
                )
            })
        })
    })

    describe('with JSON keys (vault disabled)', () => {
        const temporalKeyPrefix = 'transit/export/encryption-key/temporal-key'
        const fullKeyName1 = `${temporalKeyPrefix}/1`
        const fullKeyName2 = `${temporalKeyPrefix}/2`
        const jsonKeys = JSON.stringify({
            [fullKeyName1]: key,
            [fullKeyName2]: key2,
        })

        let codec: EncryptionCodec
        let envService: EnvService

        beforeAll(async () => {
            const logger = new DiiaLogger()

            envService = new EnvService(logger)
            codec = await EncryptionCodec.create(jsonKeys, envService, { vaultEnabled: false }, logger)
        })

        it('should use the highest version key as default', async () => {
            // Arrange
            const payload = {
                metadata: { key: encode('value') },
                data: encode('test data'),
            }

            // Act
            const [encoded] = await codec.encode([payload])

            // Assert
            expect(encoded.metadata).toEqual(
                expect.objectContaining({
                    encoding: encode('binary/encrypted'),
                    'encryption-key-id': encode(fullKeyName2),
                }),
            )
        })

        it('should encode and decode payload with the default key', async () => {
            // Arrange
            const originalPayload = {
                metadata: { key: encode('value') },
                data: encode('test data'),
            }

            // Act
            const [encoded] = await codec.encode([originalPayload])
            const [decoded] = await codec.decode([encoded])

            // Assert
            expect(decoded.metadata).toEqual(originalPayload.metadata)
            expect(decoded.data).toEqual(originalPayload.data)
        })

        it('should be able to decode payload encrypted with non-default key', async () => {
            // Arrange
            const jsonKeysWithKey3Default = JSON.stringify({
                [fullKeyName1]: key,
            })

            const codecWithKey3Default = await EncryptionCodec.create(jsonKeysWithKey3Default, envService, { vaultEnabled: false })

            const originalPayload = {
                metadata: {
                    original: encode('preserved'),
                    test: encode('value'),
                },
                data: encode('test data with key3'),
            }

            const [encoded] = await codecWithKey3Default.encode([originalPayload])

            expect(encoded.metadata).toEqual(
                expect.objectContaining({
                    'encryption-key-id': encode(fullKeyName1),
                }),
            )

            // Act
            const [decoded] = await codec.decode([encoded])

            // Assert
            expect(decoded.metadata).toBeDefined()
            expect(decoded.metadata!.original).toEqual(encode('preserved'))
            expect(decoded.metadata!.test).toEqual(encode('value'))
            expect(decoded.data).toEqual(encode('test data with key3'))
        })
    })
})
