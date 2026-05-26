import * as promClient from 'prom-client'

import { Logger, OnDestroy, OnInit } from '@diia-inhouse/types'

import type {
    ScheduleCalendarEvent,
    ScheduleRecentAction,
    SchedulesExporterConfig,
    SchedulesExporterDeps,
} from '../interfaces/services/schedulesExporter.js'

export type {
    ScheduleCalendarEvent,
    ScheduleRecentAction,
    SchedulesExporterConfig,
    SchedulesExporterDeps,
} from '../interfaces/services/schedulesExporter.js'

interface RecentActionEntry {
    key: string
    scheduleId: string
    workflowType: string
    taskQueue: string
    firedAt: string
    firedAtMs: number
    succeeded: number
}

const SCHEDULE_LABELS = ['schedule_id', 'workflow_type', 'task_queue'] as const
const SCHEDULE_SLOT_LABELS = [...SCHEDULE_LABELS, 'slot'] as const
const RUNNING_LABELS = ['workflow_type', 'task_queue'] as const

type ScheduleLabel = (typeof SCHEDULE_LABELS)[number]
type ScheduleSlotLabel = (typeof SCHEDULE_SLOT_LABELS)[number]
type RunningLabel = (typeof RUNNING_LABELS)[number]

/**
 * Periodically polls the Temporal Schedule and Visibility APIs, exposing per-schedule and
 * per-workflow-type business metrics that the SDK does not provide out of the box:
 *
 * - `diia_schedule_paused` (0/1)
 * - `diia_schedule_last_action_age_seconds`
 * - `diia_schedule_last_action_succeeded` (0/1)
 * - `diia_schedule_next_action_at_seconds{slot}` — Unix seconds of upcoming fire
 * - `diia_schedule_next_action_eta_seconds{slot}` — seconds from now until upcoming fire

 * - `diia_schedule_cadence_seconds` — approximate gap between fires (slot1 − slot0, falls back to spec)
 * - `diia_schedule_fires_total{result="ok"|"failed"}` — counter of observed schedule fires; pair
 *   with cadence to compute expected/day and detect missed runs
 * - `diia_workflows_running` — count of executions in `Running` state for this task queue
 * - `diia_workflows_oldest_running_age_seconds` — age of the oldest running workflow
 *
 * The `service` label is supplied by the `diia-metrics` default labels at scrape time, so it
 * is intentionally absent from the metric labelNames.
 *
 * Schedules with `action.taskQueue` other than `deps.taskQueue` are ignored, so a service
 * only emits metrics for schedules it actually owns. This avoids fan-out when many services
 * share a Temporal namespace.
 *
 * The exporter does NOT run its own HTTP server. Metrics flow through the existing
 * `diia-metrics` `/metrics` endpoint. If a service needs to expose the calendar event list
 * or recent action feed as JSON (e.g. for a Grafana Infinity datasource), it should call
 * {@link SchedulesExporter.getCalendarEvents} and {@link SchedulesExporter.getRecentActions}
 * from a route on its existing HTTP framework.
 */
export class SchedulesExporter implements OnInit, OnDestroy {
    private readonly pollIntervalMs: number

    private readonly visibilityPollIntervalMs: number

    private readonly pollVisibility: boolean

    private readonly nextActionSlots: number

    private readonly historySize: number

    private readonly logger: Logger | undefined

    private readonly calendarEvents: ScheduleCalendarEvent[] = []

    private readonly recentActionsLog: RecentActionEntry[] = []

    private readonly paused: promClient.Gauge<ScheduleLabel>

    private readonly lastActionAge: promClient.Gauge<ScheduleLabel>

    private readonly lastActionSucceeded: promClient.Gauge<ScheduleLabel>

    private readonly nextActionAt: promClient.Gauge<ScheduleSlotLabel>

    private readonly nextActionEta: promClient.Gauge<ScheduleSlotLabel>

    private readonly cadence: promClient.Gauge<ScheduleLabel>

    private readonly running: promClient.Gauge<RunningLabel>

    private readonly oldestRunningAge: promClient.Gauge<RunningLabel>

    private readonly firesTotal: promClient.Counter<ScheduleLabel | 'result'>

    private readonly workflowDuration: promClient.Histogram<'workflow_type' | 'task_queue'>

    private readonly seenCompletedRunIds: string[] = []

    private readonly seenCompletedRunIdSet = new Set<string>()

    // Long-lived dedup for `diia_schedule_fires_total` increments. Kept separate from
    // `recentActionsLog`, which is the user-facing window — the counter must not be
    // re-incremented for fires that fall off that window between polls.
    private readonly seenActionKeys: string[] = []

    private readonly seenActionKeySet = new Set<string>()

    private static readonly ACTIONS_SEEN_CAPACITY = 2000

    // Tracks the label set emitted for each known schedule on the previous poll, so we
    // can `.remove()` metrics for schedules that disappeared (deletion / rename / queue
    // change). Counters can't be `.reset()`, so cleanup is per-label.
    private readonly lastSeenScheduleLabels = new Map<string, Record<ScheduleLabel, string>>()

    private readonly pollCompletions: boolean

    private readonly completionsPollIntervalMs: number

    private readonly completionsLookbackMs: number

    private readonly completionsSeenCapacity: number

    private completionsLastPollMs: number

    private scheduleTimer: NodeJS.Timeout | undefined

    private visibilityTimer: NodeJS.Timeout | undefined

    private completionsTimer: NodeJS.Timeout | undefined

    private schedulesPolling = false

    private runningPolling = false

    private completionsPolling = false

    private activeSchedulesPoll: Promise<void> | undefined

    private activeRunningPoll: Promise<void> | undefined

    private activeCompletionsPoll: Promise<void> | undefined

    private stopped = false

    constructor(
        private readonly deps: SchedulesExporterDeps,
        config: SchedulesExporterConfig = {},
    ) {
        this.pollIntervalMs = config.pollIntervalMs ?? 30_000
        this.visibilityPollIntervalMs = config.visibilityPollIntervalMs ?? 10_000
        this.pollVisibility = config.pollVisibility ?? true
        this.nextActionSlots = config.nextActionSlots ?? 5
        this.historySize = config.recentActionsHistorySize ?? 200
        this.pollCompletions = config.pollCompletions ?? true
        this.completionsPollIntervalMs = config.completionsPollIntervalMs ?? 60_000
        this.completionsLookbackMs = config.completionsLookbackMs ?? 60 * 60 * 1000
        this.completionsSeenCapacity = config.completionsSeenCapacity ?? 2000
        this.completionsLastPollMs = Date.now() - this.completionsLookbackMs
        this.logger = deps.logger

        const scheduleLabels = [...SCHEDULE_LABELS]
        const scheduleSlotLabels = [...SCHEDULE_SLOT_LABELS]
        const runningLabels = [...RUNNING_LABELS]

        this.paused = getOrCreateGauge<ScheduleLabel>('diia_schedule_paused', '1 if the schedule is paused', scheduleLabels)
        this.lastActionAge = getOrCreateGauge<ScheduleLabel>(
            'diia_schedule_last_action_age_seconds',
            'Seconds since the schedule last fired (across all action results)',
            scheduleLabels,
        )
        this.lastActionSucceeded = getOrCreateGauge<ScheduleLabel>(
            'diia_schedule_last_action_succeeded',
            '1 if the most recent schedule action started a workflow successfully',
            scheduleLabels,
        )
        this.nextActionAt = getOrCreateGauge<ScheduleSlotLabel>(
            'diia_schedule_next_action_at_seconds',
            'Unix seconds of an upcoming scheduled action (slot=0 is the next fire)',
            scheduleSlotLabels,
        )
        this.nextActionEta = getOrCreateGauge<ScheduleSlotLabel>(
            'diia_schedule_next_action_eta_seconds',
            'Seconds from now until an upcoming scheduled action (slot=0 is the next fire)',
            scheduleSlotLabels,
        )
        this.cadence = getOrCreateGauge<ScheduleLabel>(
            'diia_schedule_cadence_seconds',
            'Approximate cadence between fires, derived from the gap between the next two upcoming actions (falls back to spec for single-slot schedules)',
            scheduleLabels,
        )
        this.running = getOrCreateGauge<RunningLabel>(
            'diia_workflows_running',
            'Currently running workflow executions for this task queue, by workflow type',
            runningLabels,
        )
        this.oldestRunningAge = getOrCreateGauge<RunningLabel>(
            'diia_workflows_oldest_running_age_seconds',
            'Age of the oldest running workflow per workflow type',
            runningLabels,
        )
        this.firesTotal = getOrCreateCounter<ScheduleLabel | 'result'>(
            'diia_schedule_fires_total',
            'Total schedule fires observed by the exporter, partitioned by result (ok/failed). Compare with expected fires from `diia_schedule_cadence_seconds` to detect missed runs.',
            [...scheduleLabels, 'result'],
        )
        this.workflowDuration = getOrCreateHistogram<'workflow_type' | 'task_queue'>(
            'diia_workflow_duration_seconds',
            'End-to-end duration of completed (status=Completed) workflow executions per workflow_type. Sample is taken from Temporal Visibility close_time − start_time. Pair with `diia_schedule_fires_total` to compute per-schedule cost (fires/day × p95 duration).',
            ['workflow_type', 'task_queue'],
            [1, 5, 15, 60, 180, 600, 1800, 3600, 7200, 21600, 43200, 86400],
        )
    }

    async onInit(): Promise<void> {
        // Fire initial polls without awaiting — observability must not gate `worker.run()`.
        // The `*Polling` guards prevent overlap with the first interval-driven poll.
        void this.runSchedulesPoll('initial')
        if (this.pollVisibility) {
            void this.runRunningPoll('initial')
        }

        if (this.pollCompletions) {
            void this.runCompletionsPoll('initial')
        }

        this.armSchedulesTimer()

        if (this.pollVisibility) {
            this.armVisibilityTimer()
        }

        if (this.pollCompletions) {
            this.armCompletionsTimer()
        }
    }

    async onDestroy(): Promise<void> {
        this.stopped = true

        if (this.scheduleTimer) {
            clearTimeout(this.scheduleTimer)
        }

        if (this.visibilityTimer) {
            clearTimeout(this.visibilityTimer)
        }

        if (this.completionsTimer) {
            clearTimeout(this.completionsTimer)
        }

        // Wait for in-flight polls to finish so we don't leave them writing metrics or
        // making client calls after shutdown returns. The async iterators can't be
        // cancelled, but they're bounded — let them drain.
        await Promise.allSettled([this.activeSchedulesPoll, this.activeRunningPoll, this.activeCompletionsPoll])
    }

    private armSchedulesTimer(): void {
        if (this.stopped) {
            return
        }

        this.scheduleTimer = setTimeout(() => {
            void this.runSchedulesPoll('interval').finally(() => this.armSchedulesTimer())
        }, this.pollIntervalMs)
        this.scheduleTimer.unref()
    }

    private armVisibilityTimer(): void {
        if (this.stopped) {
            return
        }

        this.visibilityTimer = setTimeout(() => {
            void this.runRunningPoll('interval').finally(() => this.armVisibilityTimer())
        }, this.visibilityPollIntervalMs)
        this.visibilityTimer.unref()
    }

    private armCompletionsTimer(): void {
        if (this.stopped) {
            return
        }

        this.completionsTimer = setTimeout(() => {
            void this.runCompletionsPoll('interval').finally(() => this.armCompletionsTimer())
        }, this.completionsPollIntervalMs)
        this.completionsTimer.unref()
    }

    private runSchedulesPoll(source: 'initial' | 'interval'): Promise<void> {
        if (this.schedulesPolling) {
            return Promise.resolve()
        }

        this.schedulesPolling = true
        const promise = (async (): Promise<void> => {
            try {
                await this.pollSchedules()
            } catch (err) {
                this.logger?.error(`SchedulesExporter ${source} schedule poll failed`, { err })
            } finally {
                this.schedulesPolling = false
                this.activeSchedulesPoll = undefined
            }
        })()

        this.activeSchedulesPoll = promise

        return promise
    }

    private runRunningPoll(source: 'initial' | 'interval'): Promise<void> {
        if (this.runningPolling) {
            return Promise.resolve()
        }

        this.runningPolling = true
        const promise = (async (): Promise<void> => {
            try {
                await this.pollRunning()
            } catch (err) {
                this.logger?.error(`SchedulesExporter ${source} visibility poll failed`, { err })
            } finally {
                this.runningPolling = false
                this.activeRunningPoll = undefined
            }
        })()

        this.activeRunningPoll = promise

        return promise
    }

    private runCompletionsPoll(source: 'initial' | 'interval'): Promise<void> {
        if (this.completionsPolling) {
            return Promise.resolve()
        }

        this.completionsPolling = true
        const promise = (async (): Promise<void> => {
            try {
                await this.pollCompleted()
            } catch (err) {
                this.logger?.error(`SchedulesExporter ${source} completions poll failed`, { err })
            } finally {
                this.completionsPolling = false
                this.activeCompletionsPoll = undefined
            }
        })()

        this.activeCompletionsPoll = promise

        return promise
    }

    /**
     * Snapshot of the next-N upcoming fires across all tracked schedules.
     * Each schedule contributes up to `nextActionSlots` events, ordered by `slot`.
     * Mount on a service HTTP route to feed the Grafana Business Calendar panel via the
     * Infinity datasource — the data shape is already calendar-event-shaped.
     */
    getCalendarEvents(): readonly ScheduleCalendarEvent[] {
        return this.calendarEvents
    }

    /**
     * Snapshot of the most recent schedule actions across all tracked schedules,
     * ordered newest first. Capped at `recentActionsHistorySize` entries.
     */
    getRecentActions(limit = 50): readonly ScheduleRecentAction[] {
        return this.recentActionsLog.slice(0, limit).map(({ key: _key, ...rest }) => rest)
    }

    private async pollSchedules(): Promise<void> {
        const events: ScheduleCalendarEvent[] = []
        const currentSeen = new Map<string, Record<ScheduleLabel, string>>()

        for await (const summary of this.deps.client.schedule.list()) {
            const handle = this.deps.client.schedule.getHandle(summary.scheduleId)
            const description = await handle.describe()
            const action = description.action

            if (action.type !== 'startWorkflow') {
                continue
            }

            if (action.taskQueue !== this.deps.taskQueue) {
                continue
            }

            const workflowType = action.workflowType
            const baseLabels: Record<ScheduleLabel, string> = {
                schedule_id: summary.scheduleId,
                workflow_type: workflowType,
                task_queue: this.deps.taskQueue,
            }

            currentSeen.set(summary.scheduleId, baseLabels)

            const info = description.info as ScheduleInfoLike
            const state = description.state
            const recentActions = info.recentActions ?? []
            const upcoming = info.nextActionTimes ?? info.futureActionTimes ?? []
            const pausedFlag = state.paused ? 1 : 0
            const cadenceLabel = describeCadence(description.spec)

            this.paused.set(baseLabels, pausedFlag)

            const lastAction = recentActions[recentActions.length - 1]
            const lastSucceeded = lastAction ? (lastAction.action ? 1 : 0) : null
            if (lastAction) {
                const at = lastAction.takenAt ?? lastAction.scheduledAt
                if (at) {
                    this.lastActionAge.set(baseLabels, (Date.now() - new Date(at).getTime()) / 1000)
                }

                this.lastActionSucceeded.set(baseLabels, lastAction.action ? 1 : 0)
            }

            for (const recent of recentActions) {
                const at = recent.takenAt ?? recent.scheduledAt
                if (!at) {
                    continue
                }

                const key = `${summary.scheduleId}|${new Date(at).toISOString()}`
                if (this.seenActionKeySet.has(key)) {
                    continue
                }

                this.seenActionKeySet.add(key)
                this.seenActionKeys.push(key)
                const succeeded = recent.action ? 1 : 0

                this.recentActionsLog.push({
                    key,
                    scheduleId: summary.scheduleId,
                    workflowType,
                    taskQueue: this.deps.taskQueue,
                    firedAt: new Date(at).toISOString(),
                    firedAtMs: new Date(at).getTime(),
                    succeeded,
                })
                this.firesTotal.inc({ ...baseLabels, result: succeeded ? 'ok' : 'failed' })
            }

            for (let slot = 0; slot < this.nextActionSlots; slot++) {
                const at = upcoming[slot]
                const slotLabels = { ...baseLabels, slot: String(slot) }
                if (!at) {
                    this.nextActionAt.remove(slotLabels)
                    this.nextActionEta.remove(slotLabels)
                    continue
                }

                const ms = new Date(at).getTime()

                this.nextActionAt.set(slotLabels, ms / 1000)
                this.nextActionEta.set(slotLabels, Math.max(0, (ms - Date.now()) / 1000))

                events.push({
                    scheduleId: summary.scheduleId,
                    workflowType,
                    taskQueue: this.deps.taskQueue,
                    cadence: cadenceLabel,
                    slot,
                    fireAt: new Date(ms).toISOString(),
                    fireAtMs: ms,
                    paused: pausedFlag,
                    lastSucceeded,
                })
            }

            const cadenceSeconds = computeCadenceSeconds(upcoming, description.spec)
            if (cadenceSeconds !== undefined) {
                this.cadence.set(baseLabels, cadenceSeconds)
            } else {
                this.cadence.remove(baseLabels)
            }
        }

        this.calendarEvents.length = 0
        this.calendarEvents.push(...events)

        this.recentActionsLog.sort((a, b) => b.firedAtMs - a.firedAtMs)
        if (this.recentActionsLog.length > this.historySize) {
            this.recentActionsLog.length = this.historySize
        }

        // LRU-trim the long-lived fire-dedup set so it doesn't grow unboundedly.
        while (this.seenActionKeys.length > SchedulesExporter.ACTIONS_SEEN_CAPACITY) {
            const evicted = this.seenActionKeys.shift()
            if (evicted) {
                this.seenActionKeySet.delete(evicted)
            }
        }

        // Schedules that were tracked last poll but are gone now (deleted, renamed,
        // moved to another task queue): drop all per-schedule series so they don't
        // emit stale values forever. Counter labels removed too since counters can't
        // be reset and the schedule_id will never re-appear.
        for (const [scheduleId, labels] of this.lastSeenScheduleLabels) {
            if (currentSeen.has(scheduleId)) {
                continue
            }

            this.paused.remove(labels)
            this.lastActionAge.remove(labels)
            this.lastActionSucceeded.remove(labels)
            this.cadence.remove(labels)
            this.firesTotal.remove({ ...labels, result: 'ok' })
            this.firesTotal.remove({ ...labels, result: 'failed' })
            for (let slot = 0; slot < this.nextActionSlots; slot++) {
                const slotLabels = { ...labels, slot: String(slot) }

                this.nextActionAt.remove(slotLabels)
                this.nextActionEta.remove(slotLabels)
            }
        }

        this.lastSeenScheduleLabels.clear()
        for (const [scheduleId, labels] of currentSeen) {
            this.lastSeenScheduleLabels.set(scheduleId, labels)
        }
    }

    private async pollRunning(): Promise<void> {
        type Bucket = { count: number; oldestStartMs: number }
        const buckets = new Map<string, Bucket>()

        const query = `TaskQueue="${this.deps.taskQueue}" AND ExecutionStatus="Running"`
        for await (const wf of this.deps.client.workflow.list({ query })) {
            const startMs = wf.startTime ? new Date(wf.startTime).getTime() : Date.now()
            const existing = buckets.get(wf.type) ?? { count: 0, oldestStartMs: Date.now() }

            existing.count += 1
            if (startMs < existing.oldestStartMs) {
                existing.oldestStartMs = startMs
            }

            buckets.set(wf.type, existing)
        }

        this.running.reset()
        this.oldestRunningAge.reset()
        for (const [workflowType, { count, oldestStartMs }] of buckets) {
            const labels = { workflow_type: workflowType, task_queue: this.deps.taskQueue }

            this.running.set(labels, count)
            this.oldestRunningAge.set(labels, (Date.now() - oldestStartMs) / 1000)
        }
    }

    private async pollCompleted(): Promise<void> {
        const sinceMs = this.completionsLastPollMs
        const nowMs = Date.now()
        const sinceIso = new Date(sinceMs).toISOString()
        // Visibility query: Completed workflows on this task queue closed since the last poll.
        // CloseTime in the visibility store is in UTC. Use ISO with quotes per Temporal docs.
        const query = `TaskQueue="${this.deps.taskQueue}" AND ExecutionStatus="Completed" AND CloseTime>="${sinceIso}"`

        let observed = 0
        for await (const wf of this.deps.client.workflow.list({ query })) {
            // The visibility iterator wraps a proto message whose own getters can return
            // proto3 defaults (empty strings) for `runId` / `type` on Completed workflows.
            // Read fields off `raw` (the underlying protobufjs message) instead — calling
            // `toJSON()` only on the inner message avoids serialising the whole wrapper
            // per workflow, which was the hot-path cost of the previous implementation.
            const raw = (wf as { raw?: ProtoCompletedWorkflowLike }).raw
            const rawJson =
                raw && typeof raw.toJSON === 'function'
                    ? (raw.toJSON() as ProtoCompletedWorkflowJson)
                    : (raw as ProtoCompletedWorkflowJson | undefined)
            const runId = rawJson?.execution?.runId
            const workflowType = rawJson?.type?.name
            const startTimeRaw = rawJson?.startTime ?? (wf.startTime ? new Date(wf.startTime).toISOString() : undefined)
            const closeTimeRaw = rawJson?.closeTime ?? (wf.closeTime ? new Date(wf.closeTime).toISOString() : undefined)

            if (!runId || !workflowType || !startTimeRaw || !closeTimeRaw) {
                continue
            }

            if (this.seenCompletedRunIdSet.has(runId)) {
                continue
            }

            const durationSec = (new Date(closeTimeRaw).getTime() - new Date(startTimeRaw).getTime()) / 1000
            if (durationSec < 0) {
                continue
            }

            this.workflowDuration.observe({ workflow_type: workflowType, task_queue: this.deps.taskQueue }, durationSec)

            this.seenCompletedRunIdSet.add(runId)
            this.seenCompletedRunIds.push(runId)
            observed++
        }

        // LRU-style trim: drop oldest run_ids once we exceed capacity.
        while (this.seenCompletedRunIds.length > this.completionsSeenCapacity) {
            const evicted = this.seenCompletedRunIds.shift()
            if (evicted) {
                this.seenCompletedRunIdSet.delete(evicted)
            }
        }

        // Advance the sliding window. Overlap = one poll interval so late-arriving
        // CloseTime writes (visibility lag) still fall inside the next window; dedup
        // via `seenCompletedRunIdSet` prevents double counting.
        this.completionsLastPollMs = nowMs - this.completionsPollIntervalMs

        if (observed > 0) {
            this.logger?.debug('SchedulesExporter pollCompleted observed completions', { taskQueue: this.deps.taskQueue, observed })
        }
    }
}

interface ProtoCompletedWorkflowJson {
    execution?: { workflowId?: string; runId?: string }
    type?: { name?: string }
    startTime?: string
    closeTime?: string
}

interface ProtoCompletedWorkflowLike extends ProtoCompletedWorkflowJson {
    toJSON?(): unknown
}

function getOrCreateGauge<L extends string>(name: string, help: string, labelNames: L[]): promClient.Gauge<L> {
    const existing = promClient.register.getSingleMetric(name)

    if (existing instanceof promClient.Gauge) {
        return existing as promClient.Gauge<L>
    }

    return new promClient.Gauge<L>({ name, help, labelNames })
}

function getOrCreateCounter<L extends string>(name: string, help: string, labelNames: L[]): promClient.Counter<L> {
    const existing = promClient.register.getSingleMetric(name)

    if (existing instanceof promClient.Counter) {
        return existing as promClient.Counter<L>
    }

    return new promClient.Counter<L>({ name, help, labelNames })
}

function getOrCreateHistogram<L extends string>(name: string, help: string, labelNames: L[], buckets: number[]): promClient.Histogram<L> {
    const existing = promClient.register.getSingleMetric(name)

    if (existing instanceof promClient.Histogram) {
        return existing as promClient.Histogram<L>
    }

    return new promClient.Histogram<L>({ name, help, labelNames, buckets })
}

interface ScheduleInfoLike {
    recentActions?: { takenAt?: Date; scheduledAt?: Date; action?: unknown }[]
    nextActionTimes?: Date[]
    futureActionTimes?: Date[]
}

interface ScheduleSpecLike {
    intervals?: { every: number | { toString(): string } }[]
    cronExpressions?: string[]
    calendars?: { hour?: number | string; minute?: number | string; comment?: string }[]
}

function describeCadence(spec: unknown): string {
    const s = spec as ScheduleSpecLike | undefined

    if (!s) {
        return 'unknown'
    }

    if (s.intervals?.length) {
        const every = s.intervals[0].every
        if (typeof every === 'number') {
            return `every ${Math.round(every / 1000)}s`
        }

        return `every ${every.toString()}`
    }

    if (s.cronExpressions?.length) {
        return s.cronExpressions[0]
    }

    if (s.calendars?.length) {
        const calendar = s.calendars[0]

        return `cal ${calendar.hour ?? '*'}:${String(calendar.minute ?? 0).padStart(2, '0')}`
    }

    return 'unknown'
}

function computeCadenceSeconds(upcoming: Date[], spec: unknown): number | undefined {
    if (upcoming.length >= 2) {
        const gap = new Date(upcoming[1]).getTime() - new Date(upcoming[0]).getTime()
        if (gap > 0) {
            return gap / 1000
        }
    }

    const s = spec as ScheduleSpecLike | undefined
    if (!s) {
        return undefined
    }

    if (s.intervals?.length) {
        const every = s.intervals[0].every
        if (typeof every === 'number') {
            return every / 1000
        }
    }

    if (s.calendars?.length) {
        return 86_400
    }

    return undefined
}
