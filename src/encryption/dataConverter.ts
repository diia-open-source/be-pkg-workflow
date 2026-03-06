import { DataConverter } from '@temporalio/common'

import { EnvService } from '@diia-inhouse/env'
import { DurationMs } from '@diia-inhouse/types'

import { EncryptionCodec } from './encryptionCodec'

let dataConverterPromise: Promise<DataConverter>
const defaultRefreshInterval = DurationMs.Day

export async function getDataConverter(keyId: string, envService: EnvService, refreshInterval?: number): Promise<DataConverter> {
    if (!dataConverterPromise) {
        dataConverterPromise = createDataConverter(keyId, envService, refreshInterval)
    }

    return await dataConverterPromise
}

async function createDataConverter(
    keyId: string,
    envService: EnvService,
    refreshInterval = defaultRefreshInterval,
): Promise<DataConverter> {
    const vaultEnabled = EnvService.getVar('VAULT_ENABLED', 'boolean', false)
    const codec = await EncryptionCodec.create(keyId, envService, { vaultEnabled })

    if (vaultEnabled && refreshInterval > 0) {
        setInterval(async () => {
            await codec?.refreshDefaultKey()
        }, refreshInterval)
    }

    return {
        payloadCodecs: [codec],
    }
}
