import { webcrypto as crypto } from 'node:crypto'

import { METADATA_ENCODING_KEY, Payload, PayloadCodec, ValueError } from '@temporalio/common'
import { decode, encode } from '@temporalio/common/lib/encoding'
import { temporal } from '@temporalio/proto'

import DiiaLogger from '@diia-inhouse/diia-logger'
import { EnvService } from '@diia-inhouse/env'
import { Logger } from '@diia-inhouse/types'

import { decrypt, encrypt } from './crypto'

export class EncryptionCodec implements PayloadCodec {
    private readonly batchSize: number
    private readonly encoding = 'binary/encrypted'
    private readonly metadataEncryptionKeyId = 'encryption-key-id'

    constructor(
        private readonly keys: Map<string, crypto.CryptoKey>,
        private defaultKeyId: string,
        private readonly envService: EnvService,
        private readonly logger: Logger,
        options: { batchSize?: number; vaultEnabled?: boolean } = {},
    ) {
        this.batchSize = options.batchSize ?? 50
        this.defaultKeyId = defaultKeyId
    }

    static async create(
        keyId: string,
        envService: EnvService,
        options: { batchSize?: number; vaultEnabled?: boolean },
        logger: Logger = new DiiaLogger(),
    ): Promise<EncryptionCodec> {
        const storedKeys = new Map<string, crypto.CryptoKey>()
        const { vaultEnabled } = options

        if (!vaultEnabled) {
            logger.info('Vault is disabled, extracting static keys from env for Temporal encryption')
            const keys: Record<string, string> = JSON.parse(keyId)
            for (const [fullKeyName, key] of Object.entries(keys)) {
                storedKeys.set(fullKeyName, await EncryptionCodec.createCryptoKey(key))
            }

            const defaultKey = Object.keys(keys).toSorted((a, b) => {
                const versionA = Number.parseInt(a.split('/').at(-1) || '0')
                const versionB = Number.parseInt(b.split('/').at(-1) || '0')

                return versionB - versionA
            })[0]

            return new this(storedKeys, defaultKey, envService, logger, options)
        }

        const { fullKeyName, key } = await envService.getTransitKey(keyId, { keyVersion: 'latest' })

        storedKeys.set(fullKeyName, await EncryptionCodec.createCryptoKey(key))

        return new this(storedKeys, fullKeyName, envService, logger, options)
    }

    private static async createCryptoKey(key: string): Promise<crypto.CryptoKey> {
        try {
            const keyBuffer = Buffer.from(key, 'base64')

            const cryptoKey = await crypto.subtle.importKey(
                'raw',
                keyBuffer,
                {
                    name: 'AES-GCM',
                    length: 256,
                },
                true,
                ['encrypt', 'decrypt'],
            )

            return cryptoKey
        } catch (err) {
            throw new Error(`Failed to create crypto key: ${(err as Error).message}`)
        }
    }

    async refreshDefaultKey(): Promise<void> {
        const { name: keyId } = this.splitKeyId(this.defaultKeyId)
        const { fullKeyName, key } = await this.envService.getTransitKey(keyId, { keyVersion: 'latest' })

        if (!this.keys.has(fullKeyName)) {
            const newKey = await EncryptionCodec.createCryptoKey(key)

            this.keys.set(fullKeyName, newKey)
            this.defaultKeyId = fullKeyName
        }
    }

    async encode(payloads: Payload[]): Promise<Payload[]> {
        return await this.processBatch(payloads, async (payload) => ({
            metadata: {
                [METADATA_ENCODING_KEY]: encode(this.encoding),
                [this.metadataEncryptionKeyId]: encode(this.defaultKeyId),
            },
            data: await encrypt(temporal.api.common.v1.Payload.encode(payload).finish(), this.keys.get(this.defaultKeyId)!),
        }))
    }

    async decode(payloads: Payload[]): Promise<Payload[]> {
        return await this.processBatch(payloads, async (payload) => {
            if (!payload.metadata || decode(payload.metadata[METADATA_ENCODING_KEY]) !== this.encoding) {
                return payload
            }

            if (!payload.data) {
                throw new ValueError('Payload data is missing')
            }

            const keyIdBytes = payload.metadata[this.metadataEncryptionKeyId]
            if (!keyIdBytes) {
                throw new ValueError('Unable to decrypt Payload without encryption key id')
            }

            const keyId = decode(keyIdBytes)
            let key = this.keys.get(keyId)
            if (!key) {
                const { name, version } = this.splitKeyId(keyId)
                const { key: rawKey } = await this.envService.getTransitKey(name, { keyVersion: version })

                this.logger.info(`Decryption key ${keyId} not found in cache, fetched from vault`)

                key = await EncryptionCodec.createCryptoKey(rawKey)
                this.keys.set(keyId, key)
            }

            const decryptedPayloadBytes = await decrypt(payload.data, key)

            return temporal.api.common.v1.Payload.decode(decryptedPayloadBytes)
        })
    }

    private async processBatch<T>(items: T[], processor: (item: T) => Promise<Payload>): Promise<Payload[]> {
        const results: Payload[] = []

        for (let i = 0; i < items.length; i += this.batchSize) {
            const batch = items.slice(i, i + this.batchSize)
            const batchPromises = batch.map(processor)
            const batchResults = await Promise.all(batchPromises)

            results.push(...batchResults)
        }

        return results
    }

    private splitKeyId(fullKeyId: string): { name: string; version: string } {
        const name = fullKeyId.split('/').slice(0, -1).join('/')
        const version = fullKeyId.split('/').at(-1)

        if (!version || Number.isNaN(Number(version))) {
            throw new Error(`Invalid key ID: ${fullKeyId}. Failed to get version`)
        }

        return { name, version }
    }
}
