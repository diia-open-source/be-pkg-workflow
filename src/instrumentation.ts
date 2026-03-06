import { OTLPTraceExporter as OTLPTraceExporterGrpc } from '@opentelemetry/exporter-trace-otlp-grpc'

import { EnvService } from '@diia-inhouse/env'

export const traceExporter = new OTLPTraceExporterGrpc({
    url:
        EnvService.getVar('TRACING_EXPORTER_URL', 'string', 'http://localhost:4317') ||
        'http://opentelemetry-collector.tracing.svc.cluster.local:4317',
})
