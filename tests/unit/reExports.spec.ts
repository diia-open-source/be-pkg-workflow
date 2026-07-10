import { describe, expect, it } from 'vitest'

import * as activityEntry from '../../src/activity'
import * as clientEntry from '../../src/client'
import * as commonEntry from '../../src/common'
import * as nexusEntry from '../../src/nexus'
import * as operationsEntry from '../../src/operations'

// Guards that the newly surfaced APIs are exported as runtime values (not accidentally dropped
// or left type-only) from each entry point.
describe('entry point re-exports', () => {
    it('/client exposes the standalone-activity and update-with-start surface', () => {
        expect(clientEntry.ActivityClient).toBeDefined()
        expect(clientEntry.ActivityIdConflictPolicy).toBeDefined()
        expect(clientEntry.ActivityIdReusePolicy).toBeDefined()
        expect(clientEntry.WithStartWorkflowOperation).toBeDefined()
        expect(clientEntry.WorkflowUpdateStage).toBeDefined()
    })

    it('/common exposes the typed search-attribute helpers', () => {
        expect(commonEntry.SearchAttributeType).toBeDefined()
        expect(commonEntry.TypedSearchAttributes).toBeDefined()
        expect(commonEntry.defineSearchAttributeKey).toBeDefined()
    })

    it('/common exposes versioning, continue-as-new and cancellation helpers', () => {
        expect(commonEntry.VersioningBehavior).toBeDefined()
        expect(commonEntry.InitialVersioningBehavior).toBeDefined()
        expect(commonEntry.toCanonicalString).toBeDefined()
        expect(commonEntry.SuggestContinueAsNewReason).toBeDefined()
        expect(commonEntry.ActivityCancellationDetails).toBeDefined()
    })

    it('/operations exposes UI-enrichment and Nexus caller helpers', () => {
        expect(operationsEntry.getCurrentDetails).toBeDefined()
        expect(operationsEntry.setCurrentDetails).toBeDefined()
        expect(operationsEntry.createNexusServiceClient).toBeDefined()
        expect(operationsEntry.NexusOperationCancellationType).toBeDefined()
    })

    it('/operations exposes definition options, random streams and default handlers', () => {
        expect(operationsEntry.setWorkflowOptions).toBeDefined()
        expect(operationsEntry.getRandomStream).toBeDefined()
        expect(operationsEntry.workflowRandom).toBeDefined()
        expect(operationsEntry.setDefaultUpdateHandler).toBeDefined()
        expect(operationsEntry.setDefaultQueryHandler).toBeDefined()
    })

    it('/activity exposes the cancellation-details, client and metrics surface', () => {
        expect(activityEntry.cancellationDetails).toBeDefined()
        expect(activityEntry.getClient).toBeDefined()
        expect(activityEntry.metricMeter).toBeDefined()
    })

    it('/nexus exposes the handler and service-definition helpers', () => {
        expect(nexusEntry.WorkflowRunOperationHandler).toBeDefined()
        expect(nexusEntry.startWorkflow).toBeDefined()
        expect(nexusEntry.getClient).toBeDefined()
        expect(nexusEntry.service).toBeDefined()
        expect(nexusEntry.operation).toBeDefined()
        expect(nexusEntry.serviceHandler).toBeDefined()
    })
})
