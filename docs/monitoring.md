## Monitoring and Observability

This service ships with integrated OpenTelemetry (OTel) support for traces, metrics, and logs. It can export data to any OTLP-compatible backend such as SigNoz, Grafana Tempo/Loki/Prometheus, Datadog, or New Relic.

### What you get out of the box

- **Traces**: Automatic spans for Express routes, outgoing HTTP calls, and Prisma (database) operations, plus useful request/response attributes.
- **Metrics**: Collected and exported every 15 seconds via OTLP HTTP.
- **Logs**: Structured logs exported via OTLP HTTP.

Instrumentation is configured in `src/tracing.ts` using the OTel Node SDK with:

- `@opentelemetry/auto-instrumentations-node` (filesystem instrumentation disabled to reduce noise)
- `@opentelemetry/instrumentation-express`
- `@opentelemetry/instrumentation-http`
- `@prisma/instrumentation`

This is a beta feature and will be improved and expanded in the future.

### Enabling the OpenTelemetry SDK

The SDK starts when `src/tracing.ts` is executed. You can enable it in one of two ways:

1. Programmatic import (simplest)

Add this as the first import in `src/index.ts`:

```ts
import './tracing';
```

2. Preload at runtime (no code change)

When running the compiled build, start it with the following command:

```bash
npm run start:trace
```

or

During development runs, you can use the following command:

```bash
npm run dev:trace
```

> Use exactly one of the options above. If both are used, the SDK may be initialized twice.

### Configuration (environment variables)

All configuration is read from environment variables in `src/utils/config/index.ts` and exposed via `CONFIG`. Relevant variables:

- **OTEL_SERVICE_NAME**: Logical service name. Default: `masumi-payment-service`.
- **OTEL_SERVICE_VERSION**: Version string for the service. Default: `0.1.0`.
- **OTEL_EXPORTER_OTLP_ENDPOINT**: Base OTLP HTTP endpoint (no path). If set, the following defaults are used:
  - Traces: `${OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces`
  - Metrics: `${OTEL_EXPORTER_OTLP_ENDPOINT}/v1/metrics`
  - Logs: `${OTEL_EXPORTER_OTLP_ENDPOINT}/v1/logs`
- **OTEL_EXPORTER_OTLP_TRACES_ENDPOINT**: Full traces URL. Overrides the default above.
- **OTEL_EXPORTER_OTLP_METRICS_ENDPOINT**: Full metrics URL. Overrides the default above.
- **OTEL_EXPORTER_OTLP_LOGS_ENDPOINT**: Full logs URL. Overrides the default above.
- **SIGNOZ_INGESTION_KEY**: Optional header `signoz-ingestion-key` added to all OTLP requests (used by SigNoz Cloud).

Minimal `.env` example for a generic OTLP collector:

```env
OTEL_SERVICE_NAME=masumi-payment-service
OTEL_SERVICE_VERSION=1.0.0
# Example: local OpenTelemetry Collector (default OTLP HTTP port 4318)
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
```

### SigNoz (self-hosted or cloud)

- Self‑hosted default gateway (inside the same docker network):

```env
OTEL_EXPORTER_OTLP_ENDPOINT=http://signoz-otel-collector:4318
```

- SigNoz Cloud (requires ingestion key):

```env
OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.<region>.signoz.cloud:443
SIGNOZ_INGESTION_KEY=<your_signoz_ingestion_key>
```

> Replace `<region>` according to your SigNoz organization. If your SigNoz environment provides distinct endpoints for traces/metrics/logs, set `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`, and `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` explicitly.

### Quick start

1. Configure your `.env` with the variables above.
2. Enable the logging and tracing as described above.
3. Run the service:

```bash
# development
npm run dev

# production
npm run build
NODE_OPTIONS="--require ./dist/tracing.js" node ./dist/index.js
```

Generate traffic by calling APIs; spans, metrics, and logs should appear in your backend within seconds.

### Data model and attributes

- Resource attributes include:
  - `service.name = OTEL_SERVICE_NAME`
  - `service.version = OTEL_SERVICE_VERSION`
- Express spans add request attributes like `http.request.body.size`, `http.request.user_agent`, `http.request.remote_addr`, `http.request.x_forwarded_for`.
- HTTP client spans add `http.client.request.body.size` and `http.client.response.body.size` when headers are present.

### Example dashboards and queries

- **Latency by route**: Group trace spans by `http.route` and show p50/p95/p99 durations.
- **Error rate**: Filter traces where `status.code != OK` and group by `http.route`.
- **DB performance**: Filter spans with instrumentation scope `prisma` and group by `db.statement` or operation name.
- **Throughput**: Count spans per minute grouped by `service.name` and `http.method`.

### Troubleshooting

- **No data arriving**

  - Verify the effective endpoints in logs. On startup, the service logs the resolved traces/metrics/logs URLs.
  - Check network egress/firewalls. Port 4318 (HTTP) must be reachable for OTLP.
  - If using SigNoz Cloud, confirm `SIGNOZ_INGESTION_KEY` is correct.

- **Double initialization**

  - Ensure you only import `./tracing` once or only preload once with `NODE_OPTIONS`.

- **TLS/Proxy issues**
  - For custom CAs or proxies, configure Node.js environment (e.g., `NODE_EXTRA_CA_CERTS`) or set explicit `OTEL_EXPORTER_OTLP_*_ENDPOINT` URLs with `https://`.

### Security considerations

- Treat `SIGNOZ_INGESTION_KEY` as a secret.
- Avoid exporting sensitive payloads. While we add body size attributes, body contents are not exported by default.

### Related docs

- See `docs/deployment.md` for deployment options.
- See `docs/configuration.md` for general configuration.
