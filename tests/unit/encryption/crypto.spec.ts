import { webcrypto as crypto } from 'crypto'

import { vi } from 'vitest'

import { decrypt, encrypt } from '../../../src/encryption/crypto'

describe('Crypto', () => {
    const testData = new Uint8Array([1, 2, 3, 4, 5])
    let cryptoKey: crypto.CryptoKey

    beforeAll(async () => {
        const keyData = Buffer.from('1234567890123456')

        cryptoKey = await crypto.subtle.importKey(
            'raw',
            keyData,
            {
                name: 'AES-GCM',
            },
            true,
            ['encrypt', 'decrypt'],
        )
    })

    describe('encrypt', () => {
        it('should encrypt data with AES-GCM', async () => {
            // Arrange
            const mockIv = new Uint8Array(12).fill(1)

            vi.spyOn(crypto, 'getRandomValues').mockImplementationOnce(() => mockIv)

            // Act
            const encryptedData = await encrypt(testData, cryptoKey)

            // Assert
            expect(encryptedData).toBeInstanceOf(Uint8Array)
            expect(encryptedData.length).toBeGreaterThan(testData.length)
            const iv = Buffer.from(encryptedData.subarray(0, 12))

            expect(iv).toEqual(Buffer.from(mockIv)) // First 12 bytes should be IV
        })

        it('should generate random IV for each encryption', async () => {
            // Act
            const encrypted1 = await encrypt(testData, cryptoKey)
            const encrypted2 = await encrypt(testData, cryptoKey)

            // Assert
            expect(encrypted1.subarray(0, 12)).not.toEqual(encrypted2.subarray(0, 12))
        })
    })

    describe('decrypt', () => {
        it('should decrypt encrypted data correctly', async () => {
            // Arrange
            const encryptedData = await encrypt(testData, cryptoKey)

            // Act
            const decryptedData = await decrypt(encryptedData, cryptoKey)

            // Assert
            expect(decryptedData).toBeInstanceOf(Uint8Array)
            expect(decryptedData).toEqual(testData)
        })

        it('should throw error when decrypting with wrong key', async () => {
            // Arrange
            const encryptedData = await encrypt(testData, cryptoKey)
            const wrongKeyData = Buffer.from('6543210987654321')
            const wrongKey = await crypto.subtle.importKey(
                'raw',
                wrongKeyData,
                {
                    name: 'AES-GCM',
                },
                true,
                ['encrypt', 'decrypt'],
            )

            // Act & Assert
            await expect(decrypt(encryptedData, wrongKey)).rejects.toThrow('The operation failed for an operation-specific reason')
        })

        it('should throw error when decrypting corrupted data', async () => {
            // Arrange
            const encryptedData = await encrypt(testData, cryptoKey)
            const corruptedData = new Uint8Array(encryptedData)

            corruptedData[15] = corruptedData[15] ^ 0xff // Flip some bits

            // Act & Assert
            await expect(decrypt(corruptedData, cryptoKey)).rejects.toThrow('The operation failed for an operation-specific reason')
        })
    })
})
