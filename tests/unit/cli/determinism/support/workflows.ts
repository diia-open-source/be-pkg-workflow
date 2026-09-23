import { condition, defineUpdate, proxyActivities, setHandler } from '@temporalio/workflow'

// As in a service's workflows index.
export { workflowInterceptors as interceptors } from '../../../../../src/interceptors'

export const confirmUpdate = defineUpdate('confirmUpdate')

const { confirmApplication } = proxyActivities<{ confirmApplication(): Promise<void> }>({ startToCloseTimeout: '10 seconds' })

/** An update that lets an activity run. */
export async function confirmApplicationWorkflow(): Promise<void> {
    let isConfirmed = false

    setHandler(confirmUpdate, () => {
        isConfirmed = true
    })

    await condition(() => isConfirmed)
    await confirmApplication()
}
