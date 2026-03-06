import { describe, expect, it } from 'vitest'

import type { QueueConnectionConfig } from '@diia-inhouse/diia-queue'

import type { AppConfig } from '../../../src/interfaces/config'
import { applyServiceProcessConfig, applyWorkerProcessConfig, bootstrapWorker, instantiateActivities } from '../../../src/services/worker'

class TestActivity {
    constructor() {}

    async activityMethod(): Promise<string> {
        return 'async result'
    }

    async activityMethod2(): Promise<number> {
        return 1
    }
}

class AnotherTestActivity {
    constructor() {}

    async activityMethod(): Promise<number> {
        return 42
    }
}

const mockApp = {
    container: {
        build: (constructor: new (...args: unknown[]) => unknown): unknown => new constructor(),
        resolve: <T = unknown>(_key: string): T => {
            throw new Error('resolve not implemented in mock')
        },
    },
    async setDeps(): Promise<unknown> {
        return this
    },
}

function buildConfig(
    overrides: {
        disableQueueConsumers?: boolean
        rabbit?: QueueConnectionConfig
        metricsPort?: number
        scrapers?: { name: string; port: number; disabled?: boolean }[]
    } = {},
): AppConfig {
    return {
        temporal: {
            taskQueue: 'test',
            encryptionEnabled: false,
            encryptionKeyId: '',
            ...(overrides.disableQueueConsumers !== undefined && {
                disableQueueConsumers: overrides.disableQueueConsumers,
            }),
        },
        metrics: {
            custom: {
                port: overrides.metricsPort ?? 3030,
                pushGateway: { isEnabled: false, url: '' },
                ...(overrides.scrapers && { scrapers: overrides.scrapers }),
            },
        },
        ...(overrides.rabbit !== undefined && { rabbit: overrides.rabbit }),
    }
}

describe('worker', () => {
    describe('applyWorkerProcessConfig', () => {
        it('should disable queue consumers on all rabbit connections by default', () => {
            const config = buildConfig({
                rabbit: {
                    serviceRulesConfig: {},
                    internal: { connection: { hostname: 'localhost' }, listenerOptions: {}, consumerEnabled: true },
                    external: { connection: { hostname: 'localhost' }, listenerOptions: {}, consumerEnabled: true },
                } as QueueConnectionConfig,
            })

            applyWorkerProcessConfig(config)

            expect(config.rabbit!.internal!.consumerEnabled).toBe(false)
            expect(config.rabbit!.external!.consumerEnabled).toBe(false)
        })

        it('should not touch non-connection entries in rabbit config', () => {
            const config = buildConfig({
                rabbit: {
                    serviceRulesConfig: {},
                    internal: { connection: { hostname: 'localhost' }, listenerOptions: {}, consumerEnabled: true },
                } as QueueConnectionConfig,
            })

            applyWorkerProcessConfig(config)

            expect((config.rabbit!.serviceRulesConfig as Record<string, unknown>).consumerEnabled).toBeUndefined()
        })

        it('should not disable queue consumers when disableQueueConsumers is false', () => {
            const config = buildConfig({
                disableQueueConsumers: false,
                rabbit: {
                    serviceRulesConfig: {},
                    internal: { connection: { hostname: 'localhost' }, listenerOptions: {}, consumerEnabled: true },
                    external: { connection: { hostname: 'localhost' }, listenerOptions: {}, consumerEnabled: true },
                } as QueueConnectionConfig,
            })

            applyWorkerProcessConfig(config)

            expect(config.rabbit!.internal!.consumerEnabled).toBe(true)
            expect(config.rabbit!.external!.consumerEnabled).toBe(true)
        })

        it('should handle missing rabbit config gracefully', () => {
            const config = buildConfig()

            expect(() => applyWorkerProcessConfig(config)).not.toThrow()
        })

        it('should override metrics port from temporal-worker scraper and disable it', () => {
            const config = buildConfig({
                metricsPort: 3030,
                scrapers: [
                    { name: 'temporal', port: 3032 },
                    { name: 'temporal-worker', port: 3033 },
                ],
            })

            applyWorkerProcessConfig(config)

            expect(config.metrics.custom.port).toBe(3033)

            const workerScraper = config.metrics.custom.scrapers!.find((s) => s.name === 'temporal-worker')

            expect(workerScraper!.disabled).toBe(true)

            const temporalScraper = config.metrics.custom.scrapers!.find((s) => s.name === 'temporal')

            expect(temporalScraper!.disabled).toBeUndefined()
        })

        it('should not override metrics port when no temporal-worker scraper', () => {
            const config = buildConfig({ metricsPort: 3030 })

            applyWorkerProcessConfig(config)

            expect(config.metrics.custom.port).toBe(3030)
        })
    })

    describe('applyServiceProcessConfig', () => {
        it('should disable temporal and temporal-worker scrapers when workerInProcess is false', () => {
            const config = buildConfig({
                scrapers: [
                    { name: 'temporal', port: 3032 },
                    { name: 'temporal-worker', port: 3033 },
                ],
            })

            config.temporal.workerInProcess = false

            applyServiceProcessConfig(config)

            const temporalScraper = config.metrics.custom.scrapers!.find((s) => s.name === 'temporal')
            const workerScraper = config.metrics.custom.scrapers!.find((s) => s.name === 'temporal-worker')

            expect(temporalScraper!.disabled).toBe(true)
            expect(workerScraper!.disabled).toBe(true)
        })

        it('should not modify scrapers when workerInProcess is true', () => {
            const config = buildConfig({
                scrapers: [
                    { name: 'temporal', port: 3032 },
                    { name: 'temporal-worker', port: 3033 },
                ],
            })

            config.temporal.workerInProcess = true

            applyServiceProcessConfig(config)

            const temporalScraper = config.metrics.custom.scrapers!.find((s) => s.name === 'temporal')
            const workerScraper = config.metrics.custom.scrapers!.find((s) => s.name === 'temporal-worker')

            expect(temporalScraper!.disabled).toBeUndefined()
            expect(workerScraper!.disabled).toBeUndefined()
        })

        it('should not modify scrapers when workerInProcess is undefined', () => {
            const config = buildConfig({
                scrapers: [
                    { name: 'temporal', port: 3032 },
                    { name: 'temporal-worker', port: 3033 },
                ],
            })

            applyServiceProcessConfig(config)

            const temporalScraper = config.metrics.custom.scrapers!.find((s) => s.name === 'temporal')
            const workerScraper = config.metrics.custom.scrapers!.find((s) => s.name === 'temporal-worker')

            expect(temporalScraper!.disabled).toBeUndefined()
            expect(workerScraper!.disabled).toBeUndefined()
        })

        it('should handle missing scrapers gracefully', () => {
            const config = buildConfig()

            config.temporal.workerInProcess = false

            expect(() => applyServiceProcessConfig(config)).not.toThrow()
        })

        it('should not affect non-temporal scrapers', () => {
            const config = buildConfig({
                scrapers: [
                    { name: 'temporal', port: 3032 },
                    { name: 'temporal-worker', port: 3033 },
                    { name: 'custom-scraper', port: 3040 },
                ],
            })

            config.temporal.workerInProcess = false

            applyServiceProcessConfig(config)

            const customScraper = config.metrics.custom.scrapers!.find((s) => s.name === 'custom-scraper')

            expect(customScraper!.disabled).toBeUndefined()
        })
    })

    describe('bootstrapWorker', () => {
        it('should disable temporal scrapers and return when workerInProcess is false', async () => {
            const config = buildConfig({
                scrapers: [
                    { name: 'temporal', port: 3032 },
                    { name: 'temporal-worker', port: 3033 },
                ],
            })

            config.temporal.workerInProcess = false

            const app = {
                ...mockApp,
                getConfig: (): AppConfig => config,
            }

            await bootstrapWorker(app, {
                workflowsPath: '/fake/path',
                activities: {},
            })

            const temporalScraper = config.metrics.custom.scrapers!.find((s) => s.name === 'temporal')
            const workerScraper = config.metrics.custom.scrapers!.find((s) => s.name === 'temporal-worker')

            expect(temporalScraper!.disabled).toBe(true)
            expect(workerScraper!.disabled).toBe(true)
        })
    })

    describe('prepareActivities', () => {
        it('should bind single activity instance methods', async () => {
            const activities = instantiateActivities(mockApp, { test: TestActivity })

            expect(Object.keys(activities)).toEqual(['test.activityMethod', 'test.activityMethod2'])

            const asyncResult = await activities['test.activityMethod']()

            expect(asyncResult).toBe('async result')

            const syncResult = await activities['test.activityMethod2']()

            expect(syncResult).toBe(1)
        })

        it('should bind multiple activity instances', async () => {
            const activities = instantiateActivities(mockApp, {
                test: TestActivity,
                another: AnotherTestActivity,
            })

            expect(Object.keys(activities)).toEqual(['test.activityMethod', 'test.activityMethod2', 'another.activityMethod'])

            const activityMethodResult = await activities['another.activityMethod']()

            expect(activityMethodResult).toBe(42)
        })

        it('should handle empty activity instances object', () => {
            const activities = instantiateActivities(mockApp, {})

            expect(Object.keys(activities)).toEqual([])
        })

        it('should preserve this context in bound methods', async () => {
            class ContextTestActivity {
                private value = 'test value'

                constructor() {}

                getValue(): string {
                    return this.value
                }
            }

            const activities = instantiateActivities(mockApp, { test: ContextTestActivity })

            const result = await activities['test.getValue']()

            expect(result).toBe('test value')
        })

        it('should exclude constructor from bound methods', () => {
            const activities = instantiateActivities(mockApp, { test: TestActivity })

            expect(Object.keys(activities)).not.toContain('test.constructor')
        })

        it('should handle activity instance with no methods', () => {
            class EmptyActivity {
                constructor() {}
            }

            const activities = instantiateActivities(mockApp, { test: EmptyActivity })

            expect(Object.keys(activities)).toEqual([])
        })
    })
})
