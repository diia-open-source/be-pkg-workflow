import { hostname } from 'node:os'

export function buildWorkerIdentity(taskQueue: string, identityOverride?: string): string {
    if (identityOverride) {
        return identityOverride
    }

    return `${hostname()}-${process.pid}-${taskQueue}`
}
