import * as promClient from 'prom-client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { SchedulesExporter } from '../../../src/services/schedulesExporter'

interface FakeAction {
    type: 'startWorkflow'
    workflowType: string
    taskQueue: string
}

interface FakeRecentAction {
    takenAt?: Date
    scheduledAt?: Date
    action?: { workflowId: string }
}

interface FakeScheduleDescription {
    action: FakeAction | { type: 'unknown' }
    info: {
        recentActions?: FakeRecentAction[]
        nextActionTimes?: Date[]
    }
    state: { paused: boolean }
    spec: { intervals?: { every: number }[]; cronExpressions?: string[] }
}

interface FakeWorkflow {
    type: string
    startTime: Date
    taskQueue: string
}

interface FakeCompletedWorkflow {
    runId: string
    workflowType: string
    startTime: Date
    closeTime: Date
}

interface FakeScheduleSummary {
    scheduleId: string
}

interface FakeScheduleHandle {
    describe: () => Promise<FakeScheduleDescription>
}

interface FakeScheduleService {
    list: () => AsyncIterable<FakeScheduleSummary>
    getHandle: (id: string) => FakeScheduleHandle
}

interface FakeWorkflowListOpts {
    query?: string
}

interface FakeWorkflowEnvelope {
    raw?: { toJSON?(): unknown; execution?: { runId?: string }; type?: { name?: string }; startTime?: string; closeTime?: string }
    type?: string
    startTime?: Date
    closeTime?: Date
    taskQueue?: string
}

interface FakeWorkflowService {
    list: (opts?: FakeWorkflowListOpts) => AsyncIterable<FakeWorkflowEnvelope>
}

interface FakeClient {
    schedule: FakeScheduleService
    workflow: FakeWorkflowService
}

interface FakeClientCallCounters {
    listCalls: { count: number }
    workflowListCalls: { count: number; queries: string[] }
}

interface FakeClientFactoryOpts {
    schedules: { id: string; description: FakeScheduleDescription }[]
    runningWorkflows?: FakeWorkflow[]
    completedWorkflows?: FakeCompletedWorkflow[]
}

interface FakeClientFactoryResult extends FakeClientCallCounters {
    client: FakeClient
}

function buildFakeClient(opts: FakeClientFactoryOpts): FakeClientFactoryResult {
    const listCalls = { count: 0 }
    const workflowListCalls: { count: number; queries: string[] } = { count: 0, queries: [] }

    return {
        client: {
            schedule: {
                list(): AsyncIterable<FakeScheduleSummary> {
                    listCalls.count += 1
                    const items = opts.schedules.map((s) => ({ scheduleId: s.id }))

                    return {
                        [Symbol.asyncIterator](): AsyncIterator<{ scheduleId: string }> {
                            let i = 0

                            return {
                                next(): Promise<IteratorResult<{ scheduleId: string }>> {
                                    if (i < items.length) {
                                        return Promise.resolve({ value: items[i++], done: false })
                                    }

                                    return Promise.resolve({ value: undefined as never, done: true })
                                },
                            }
                        },
                    }
                },
                getHandle(id: string): FakeScheduleHandle {
                    const found = opts.schedules.find((s) => s.id === id)

                    if (!found) {
                        throw new Error(`unknown schedule ${id}`)
                    }

                    return { describe: (): Promise<FakeScheduleDescription> => Promise.resolve(found.description) }
                },
            },
            workflow: {
                list(listOpts?: FakeWorkflowListOpts): AsyncIterable<FakeWorkflowEnvelope> {
                    workflowListCalls.count += 1
                    if (listOpts?.query) {
                        workflowListCalls.queries.push(listOpts.query)
                    }

                    const isCompletedQuery = listOpts?.query?.includes('ExecutionStatus="Completed"') ?? false
                    const items: FakeWorkflowEnvelope[] = isCompletedQuery
                        ? (opts.completedWorkflows ?? []).map(
                              (c): FakeWorkflowEnvelope => ({
                                  raw: {
                                      execution: { runId: c.runId },
                                      type: { name: c.workflowType },
                                      startTime: c.startTime.toISOString(),
                                      closeTime: c.closeTime.toISOString(),
                                      toJSON(): unknown {
                                          return {
                                              execution: { runId: c.runId },
                                              type: { name: c.workflowType },
                                              startTime: c.startTime.toISOString(),
                                              closeTime: c.closeTime.toISOString(),
                                          }
                                      },
                                  },
                              }),
                          )
                        : (opts.runningWorkflows ?? []).map(
                              (w): FakeWorkflowEnvelope => ({ type: w.type, startTime: w.startTime, taskQueue: w.taskQueue }),
                          )

                    return {
                        [Symbol.asyncIterator](): AsyncIterator<FakeWorkflowEnvelope> {
                            let i = 0

                            return {
                                next(): Promise<IteratorResult<FakeWorkflowEnvelope>> {
                                    if (i < items.length) {
                                        return Promise.resolve({ value: items[i++], done: false })
                                    }

                                    return Promise.resolve({ value: undefined as never, done: true })
                                },
                            }
                        },
                    }
                },
            },
        },
        listCalls,
        workflowListCalls,
    }
}

function gaugeValue(metricName: string, labels: Record<string, string>): number | undefined {
    const metric = promClient.register.getSingleMetric(metricName)

    if (!metric) {
        return undefined
    }

    const json = metric as unknown as { hashMap: Record<string, { value: number; labels: Record<string, string> }> }
    for (const entry of Object.values(json.hashMap)) {
        const matches = Object.entries(labels).every(([k, v]) => entry.labels[k] === v)

        if (matches) {
            return entry.value
        }
    }

    return undefined
}

interface HistogramAggregateResult {
    count: number
    sum: number
}

function histogramAggregate(metricName: string, labels: Record<string, string>): HistogramAggregateResult {
    const metric = promClient.register.getSingleMetric(metricName)

    if (!metric) {
        return { count: 0, sum: 0 }
    }

    const json = metric as unknown as { hashMap: Record<string, { labels: Record<string, string>; sum: number; count: number }> }
    let count = 0
    let sum = 0
    for (const entry of Object.values(json.hashMap)) {
        const matches = Object.entries(labels).every(([k, v]) => entry.labels[k] === v)
        if (!matches) {
            continue
        }

        count += entry.count
        sum += entry.sum
    }

    return { count, sum }
}

describe('SchedulesExporter', () => {
    beforeEach(() => {
        promClient.register.clear()
    })

    afterEach(() => {
        promClient.register.clear()
    })

    it('emits gauges for schedules whose taskQueue matches the worker', async () => {
        const fixedNow = new Date('2026-05-07T10:00:00Z')
        const fixed = fixedNow.getTime()

        const fake = buildFakeClient({
            schedules: [
                {
                    id: 'marriage-applications-cancellation',
                    description: {
                        action: {
                            type: 'startWorkflow',
                            workflowType: 'startMarriageApplicationCancellationWorkflow',
                            taskQueue: 'MarriageQueue',
                        },
                        info: {
                            recentActions: [{ takenAt: new Date(fixed - 30_000), action: { workflowId: 'wf-1' } }],
                            nextActionTimes: [new Date(fixed + 60_000), new Date(fixed + 120_000)],
                        },
                        state: { paused: false },
                        spec: { intervals: [{ every: 60_000 }] },
                    },
                },
                {
                    id: 'someone-elses-schedule',
                    description: {
                        action: { type: 'startWorkflow', workflowType: 'foreignWorkflow', taskQueue: 'OtherQueue' },
                        info: { recentActions: [], nextActionTimes: [] },
                        state: { paused: false },
                        spec: { intervals: [{ every: 60_000 }] },
                    },
                },
            ],
        })

        const exporter = new SchedulesExporter(
            { client: fake.client as never, taskQueue: 'MarriageQueue' },
            { pollVisibility: false, pollIntervalMs: 60_000 },
        )

        try {
            await exporter['pollSchedules']()
        } finally {
            // Make sure no timers leaked.
            await exporter.onDestroy()
        }

        const matchingLabels = {
            schedule_id: 'marriage-applications-cancellation',
            workflow_type: 'startMarriageApplicationCancellationWorkflow',
            task_queue: 'MarriageQueue',
        }

        expect(gaugeValue('diia_schedule_paused', matchingLabels)).toBe(0)
        expect(gaugeValue('diia_schedule_last_action_succeeded', matchingLabels)).toBe(1)
        expect(gaugeValue('diia_schedule_next_action_at_seconds', { ...matchingLabels, slot: '0' })).toBe((fixed + 60_000) / 1000)
        expect(gaugeValue('diia_schedule_next_action_at_seconds', { ...matchingLabels, slot: '1' })).toBe((fixed + 120_000) / 1000)
        expect(
            gaugeValue('diia_schedule_paused', {
                schedule_id: 'someone-elses-schedule',
                workflow_type: 'foreignWorkflow',
                task_queue: 'OtherQueue',
            }),
        ).toBeUndefined()

        const events = exporter.getCalendarEvents()

        expect(events).toHaveLength(2)
        expect(events[0]).toMatchObject({ scheduleId: 'marriage-applications-cancellation', slot: 0, fireAtMs: fixed + 60_000 })
        expect(events[1]).toMatchObject({ slot: 1, fireAtMs: fixed + 120_000 })

        const recents = exporter.getRecentActions()

        expect(recents).toHaveLength(1)
        expect(recents[0]).toMatchObject({ scheduleId: 'marriage-applications-cancellation', succeeded: 1 })
    })

    it('reflects paused state and the most recent action result', async () => {
        const fixed = Date.now()
        const fake = buildFakeClient({
            schedules: [
                {
                    id: 'paused-one',
                    description: {
                        action: { type: 'startWorkflow', workflowType: 'wf', taskQueue: 'Q' },
                        info: {
                            recentActions: [
                                { takenAt: new Date(fixed - 10_000), action: { workflowId: 'wf-a' } },
                                { takenAt: new Date(fixed - 1_000) },
                            ],
                            nextActionTimes: [],
                        },
                        state: { paused: true },
                        spec: { intervals: [{ every: 60_000 }] },
                    },
                },
            ],
        })

        const exporter = new SchedulesExporter({ client: fake.client as never, taskQueue: 'Q' }, { pollVisibility: false })

        await exporter['pollSchedules']()
        await exporter.onDestroy()

        const labels = { schedule_id: 'paused-one', workflow_type: 'wf', task_queue: 'Q' }

        expect(gaugeValue('diia_schedule_paused', labels)).toBe(1)
        expect(gaugeValue('diia_schedule_last_action_succeeded', labels)).toBe(0) // last had no `action`
    })

    it('produces running counts and oldest age from the visibility query', async () => {
        const fixed = Date.now()
        const fake = buildFakeClient({
            schedules: [],
            runningWorkflows: [
                { type: 'wfA', startTime: new Date(fixed - 5_000), taskQueue: 'Q' },
                { type: 'wfA', startTime: new Date(fixed - 30_000), taskQueue: 'Q' },
                { type: 'wfB', startTime: new Date(fixed - 1_000), taskQueue: 'Q' },
            ],
        })

        const exporter = new SchedulesExporter({ client: fake.client as never, taskQueue: 'Q' })

        await exporter['pollRunning']()
        await exporter.onDestroy()

        expect(gaugeValue('diia_workflows_running', { workflow_type: 'wfA', task_queue: 'Q' })).toBe(2)
        expect(gaugeValue('diia_workflows_running', { workflow_type: 'wfB', task_queue: 'Q' })).toBe(1)

        const ageA = gaugeValue('diia_workflows_oldest_running_age_seconds', { workflow_type: 'wfA', task_queue: 'Q' })

        expect(ageA).toBeGreaterThanOrEqual(29.9)
        expect(ageA).toBeLessThanOrEqual(31)

        // The visibility query must filter by status and task queue.
        expect(fake.workflowListCalls.queries[0]).toContain('TaskQueue="Q"')
        expect(fake.workflowListCalls.queries[0]).toContain('ExecutionStatus="Running"')
    })

    it('skips visibility polling when pollVisibility is false', async () => {
        const fake = buildFakeClient({ schedules: [] })
        const exporter = new SchedulesExporter(
            { client: fake.client as never, taskQueue: 'Q' },
            { pollVisibility: false, pollCompletions: false },
        )

        await exporter.onInit()
        await exporter.onDestroy()

        expect(fake.workflowListCalls.count).toBe(0)
    })

    it('observes workflow durations for completed executions via raw.toJSON()', async () => {
        const fixed = Date.now()
        const fake = buildFakeClient({
            schedules: [],
            completedWorkflows: [
                { runId: 'run-1', workflowType: 'wfA', startTime: new Date(fixed - 120_000), closeTime: new Date(fixed - 60_000) },
                { runId: 'run-2', workflowType: 'wfA', startTime: new Date(fixed - 90_000), closeTime: new Date(fixed - 30_000) },
                { runId: 'run-3', workflowType: 'wfB', startTime: new Date(fixed - 10_000), closeTime: new Date(fixed - 5_000) },
            ],
        })

        const exporter = new SchedulesExporter({ client: fake.client as never, taskQueue: 'Q' }, { pollVisibility: false })

        await exporter['pollCompleted']()
        await exporter.onDestroy()

        const wfA = histogramAggregate('diia_workflow_duration_seconds', { workflow_type: 'wfA', task_queue: 'Q' })
        const wfB = histogramAggregate('diia_workflow_duration_seconds', { workflow_type: 'wfB', task_queue: 'Q' })

        expect(wfA.count).toBe(2)
        expect(wfA.sum).toBe(60 + 60)
        expect(wfB.count).toBe(1)
        expect(wfB.sum).toBe(5)
        expect(fake.workflowListCalls.queries[0]).toContain('ExecutionStatus="Completed"')
        expect(fake.workflowListCalls.queries[0]).toContain('CloseTime>=')
    })

    it('deduplicates completed workflows across overlapping polls by runId', async () => {
        const fixed = Date.now()
        const fake = buildFakeClient({
            schedules: [],
            completedWorkflows: [
                { runId: 'run-dup', workflowType: 'wfA', startTime: new Date(fixed - 20_000), closeTime: new Date(fixed - 10_000) },
            ],
        })

        const exporter = new SchedulesExporter({ client: fake.client as never, taskQueue: 'Q' }, { pollVisibility: false })

        await exporter['pollCompleted']()
        await exporter['pollCompleted']()
        await exporter.onDestroy()

        const wfA = histogramAggregate('diia_workflow_duration_seconds', { workflow_type: 'wfA', task_queue: 'Q' })

        expect(wfA.count).toBe(1)
    })

    it('does not double-count fires when the display log overflows historySize', async () => {
        const fixed = Date.now()
        const fake = buildFakeClient({
            schedules: [
                {
                    id: 'busy',
                    description: {
                        action: { type: 'startWorkflow', workflowType: 'wf', taskQueue: 'Q' },
                        info: {
                            recentActions: [
                                { takenAt: new Date(fixed - 5_000), action: { workflowId: 'w1' } },
                                { takenAt: new Date(fixed - 4_000), action: { workflowId: 'w2' } },
                                { takenAt: new Date(fixed - 3_000), action: { workflowId: 'w3' } },
                                { takenAt: new Date(fixed - 2_000), action: { workflowId: 'w4' } },
                                { takenAt: new Date(fixed - 1_000), action: { workflowId: 'w5' } },
                            ],
                            nextActionTimes: [],
                        },
                        state: { paused: false },
                        spec: { intervals: [{ every: 60_000 }] },
                    },
                },
            ],
        })

        const exporter = new SchedulesExporter(
            { client: fake.client as never, taskQueue: 'Q' },
            // Tiny display window guarantees trim drops most entries, exposing the
            // counter dedup if it were tied to recentActionsLog.
            { pollVisibility: false, pollCompletions: false, recentActionsHistorySize: 2 },
        )

        await exporter['pollSchedules']()
        await exporter['pollSchedules']()
        await exporter.onDestroy()

        const okFires = gaugeValue('diia_schedule_fires_total', {
            schedule_id: 'busy',
            workflow_type: 'wf',
            task_queue: 'Q',
            result: 'ok',
        })

        expect(okFires).toBe(5)
    })

    it('removes metrics for schedules that disappear between polls', async () => {
        const fixed = Date.now()
        const opts: FakeClientFactoryOpts = {
            schedules: [
                {
                    id: 'gone-soon',
                    description: {
                        action: { type: 'startWorkflow', workflowType: 'wf', taskQueue: 'Q' },
                        info: {
                            recentActions: [{ takenAt: new Date(fixed - 1_000), action: { workflowId: 'wf-1' } }],
                            nextActionTimes: [new Date(fixed + 60_000)],
                        },
                        state: { paused: false },
                        spec: { intervals: [{ every: 60_000 }] },
                    },
                },
            ],
        }
        const fake = buildFakeClient(opts)
        const exporter = new SchedulesExporter(
            { client: fake.client as never, taskQueue: 'Q' },
            { pollVisibility: false, pollCompletions: false },
        )
        const labels = { schedule_id: 'gone-soon', workflow_type: 'wf', task_queue: 'Q' }

        await exporter['pollSchedules']()

        expect(gaugeValue('diia_schedule_paused', labels)).toBe(0)
        expect(gaugeValue('diia_schedule_next_action_at_seconds', { ...labels, slot: '0' })).toBe((fixed + 60_000) / 1000)
        expect(gaugeValue('diia_schedule_fires_total', { ...labels, result: 'ok' })).toBe(1)

        opts.schedules.length = 0

        await exporter['pollSchedules']()
        await exporter.onDestroy()

        expect(gaugeValue('diia_schedule_paused', labels)).toBeUndefined()
        expect(gaugeValue('diia_schedule_next_action_at_seconds', { ...labels, slot: '0' })).toBeUndefined()
        expect(gaugeValue('diia_schedule_fires_total', { ...labels, result: 'ok' })).toBeUndefined()
    })

    it('skips completions polling when pollCompletions is false', async () => {
        const fake = buildFakeClient({
            schedules: [],
            completedWorkflows: [
                { runId: 'run-x', workflowType: 'wfA', startTime: new Date(Date.now() - 5_000), closeTime: new Date(Date.now() - 1_000) },
            ],
        })
        const exporter = new SchedulesExporter(
            { client: fake.client as never, taskQueue: 'Q' },
            { pollVisibility: false, pollCompletions: false },
        )

        await exporter.onInit()
        await exporter.onDestroy()

        const completionsQueries = fake.workflowListCalls.queries.filter((q) => q.includes('ExecutionStatus="Completed"'))

        expect(completionsQueries).toHaveLength(0)
    })
})
