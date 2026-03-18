import path from 'node:path'

import { ReplayWorkerOptions } from '@temporalio/worker'

import { EnvService } from '@diia-inhouse/env'

import { getDataConverter } from '../../encryption'

export function resolveWorkflowsPath(workflowsPath: string): string {
    const baseDir = path.resolve('./dist')
    const fullPath = path.resolve(baseDir, workflowsPath, 'index.js')

    if (!fullPath.startsWith(baseDir + path.sep)) {
        throw new Error(`Invalid workflows path: path traversal detected in '${workflowsPath}'`)
    }

    return fullPath
}

export async function buildReplayOptions(
    workflowsPath: string,
    encryption: { enabled: boolean; keyId: string },
    envService?: EnvService,
): Promise<ReplayWorkerOptions> {
    const fullPath = resolveWorkflowsPath(workflowsPath)
    const options: ReplayWorkerOptions = { workflowsPath: fullPath }

    if (encryption.enabled && envService) {
        options.dataConverter = await getDataConverter(encryption.keyId, envService)
    }

    return options
}
