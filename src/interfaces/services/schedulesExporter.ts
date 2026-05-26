import type { Client } from '@temporalio/client'

import type { Logger } from '@diia-inhouse/types'

export interface SchedulesExporterConfig {
    /**
     * Polling interval for `client.schedule.list()` and `describe()`. Default 30s.
     */
    pollIntervalMs?: number
    /**
     * Polling interval for the visibility query that powers `diia_workflows_running`.
     * Default 10s. Ignored when `pollVisibility` is `false`.
     */
    visibilityPollIntervalMs?: number
    /**
     * If `false`, skip the visibility query (`workflow.list({ status=Running })`). Use this
     * when the Temporal cluster does not have advanced visibility (Elasticsearch) enabled.
     * Default `true`.
     */
    pollVisibility?: boolean
    /**
     * How many upcoming fire times to expose per schedule as `slot=0..N-1` gauges.
     * Default 5.
     */
    nextActionSlots?: number
    /**
     * Maximum number of recent action events kept in memory for the `getRecentActions()`
     * snapshot. Default 200.
     */
    recentActionsHistorySize?: number
    /**
     * If `false`, skip the completed-executions query that powers `diia_workflow_duration_seconds`.
     * Default `true`. Disable when you have no advanced visibility, or when duration
     * tracking is handled elsewhere (e.g. via the SDK's `workflow_endtoend_latency` metric).
     */
    pollCompletions?: boolean
    /**
     * Polling interval for the completed-executions query. Default 60s.
     */
    completionsPollIntervalMs?: number
    /**
     * How far back the FIRST completions poll looks (subsequent polls use a sliding window
     * based on the previous poll time). Set this to roughly the histogram retention you want
     * after a fresh restart. Default 1h.
     */
    completionsLookbackMs?: number
    /**
     * Maximum number of recently-observed completed run IDs kept in memory for de-duplication
     * across overlapping polls. LRU-trimmed. Default 2000.
     */
    completionsSeenCapacity?: number
}

export interface SchedulesExporterDeps {
    /**
     * Temporal client used to call `schedule.list`, `schedule.getHandle().describe`, and
     * `workflow.list`. Typed as `Pick<Client, 'schedule' | 'workflow'>` so this interface
     * stays decoupled from the `TemporalClient` wrapper class (avoids a cycle through
     * `interfaces/config.ts`); the wrapper's `schedule`/`workflow` getters satisfy this shape.
     */
    client: Pick<Client, 'schedule' | 'workflow'>
    /**
     * The worker's task queue. Schedules whose `action.taskQueue` does not match are
     * ignored — this guarantees each service emits metrics only for the schedules it owns.
     */
    taskQueue: string
    logger?: Logger
}

/**
 * Single upcoming schedule fire returned by `SchedulesExporter.getCalendarEvents()`.
 * Each schedule contributes up to `nextActionSlots` events, ordered by `slot` ascending
 * (slot 0 is the next fire).
 */
export interface ScheduleCalendarEvent {
    scheduleId: string
    workflowType: string
    taskQueue: string
    cadence: string
    slot: number
    fireAt: string
    fireAtMs: number
    paused: number
    lastSucceeded: number | null
}

/**
 * Single recent schedule action returned by `SchedulesExporter.getRecentActions()`.
 */
export interface ScheduleRecentAction {
    scheduleId: string
    workflowType: string
    taskQueue: string
    firedAt: string
    firedAtMs: number
    succeeded: number
}
