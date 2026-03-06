import { OpenTelemetryInboundInterceptor, OpenTelemetryOutboundInterceptor } from '@temporalio/interceptors-opentelemetry'
import { WorkflowInterceptorsFactory } from '@temporalio/workflow'

export const workflowInterceptors: WorkflowInterceptorsFactory = () => ({
    inbound: [new OpenTelemetryInboundInterceptor()],
    outbound: [new OpenTelemetryOutboundInterceptor()],
})
