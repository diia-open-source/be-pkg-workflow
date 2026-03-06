import { hostname } from 'node:os'

import { describe, expect, it } from 'vitest'

import { buildWorkerIdentity } from '../../../../src/services/worker/identity'

describe('buildWorkerIdentity', () => {
    it('should use override when provided', () => {
        const result = buildWorkerIdentity('my-queue', 'custom-identity')

        expect(result).toBe('custom-identity')
    })

    it('should build default identity from hostname, pid and taskQueue', () => {
        const result = buildWorkerIdentity('my-queue')

        expect(result).toBe(`${hostname()}-${process.pid}-my-queue`)
    })

    it('should build default identity when override is not provided', () => {
        const identityOverride: string | undefined = undefined
        const result = buildWorkerIdentity('another-queue', identityOverride)

        expect(result).toBe(`${hostname()}-${process.pid}-another-queue`)
    })

    it('should build default identity when override is empty string', () => {
        const result = buildWorkerIdentity('test-queue', '')

        expect(result).toBe(`${hostname()}-${process.pid}-test-queue`)
    })
})
