import { OpenTelemetryInboundInterceptor, OpenTelemetryOutboundInterceptor } from '@temporalio/interceptors-opentelemetry/lib/workflow'
import { WorkflowInterceptorsFactory } from '@temporalio/workflow'

export const workflowInterceptors: WorkflowInterceptorsFactory = () => ({
    inbound: [new OpenTelemetryInboundInterceptor()],
    outbound: [new OpenTelemetryOutboundInterceptor()],
})
