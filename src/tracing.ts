import * as dotenv from 'dotenv';
import process from 'process';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { Span } from '@opentelemetry/api';
import { IncomingMessage, OutgoingMessage } from 'http';
import { Request } from 'express';
import { PrismaInstrumentation } from '@prisma/instrumentation';

dotenv.config();

// Service information
const serviceName = process.env.OTEL_SERVICE_NAME || 'masumi-payment-service';
const serviceVersion = process.env.OTEL_SERVICE_VERSION || '0.1.0';

// OTLP endpoints
const otlpEndpoint =
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318';
const traceEndpoint =
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || `${otlpEndpoint}/v1/traces`;
const metricsEndpoint =
  process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ||
  `${otlpEndpoint}/v1/metrics`;

// Resource configuration
const resource = resourceFromAttributes({
  [ATTR_SERVICE_NAME]: serviceName,
  [ATTR_SERVICE_VERSION]: serviceVersion,
});

// Build headers from environment variables
const headers: Record<string, string> = {};
if (process.env.SIGNOZ_INGESTION_KEY) {
  headers['signoz-ingestion-key'] = process.env.SIGNOZ_INGESTION_KEY;
}

// Trace exporter configuration
const traceExporter = new OTLPTraceExporter({
  url: traceEndpoint,
  headers,
});

// Metrics exporter configuration
const metricExporter = new OTLPMetricExporter({
  url: metricsEndpoint,
  headers,
});

// Metric reader with 15-second collection interval
const metricReader = new PeriodicExportingMetricReader({
  exporter: metricExporter,
  exportIntervalMillis: 15000,
});

// Enhanced instrumentations for comprehensive monitoring
const instrumentations = [
  // Auto-instrumentations for common libraries
  getNodeAutoInstrumentations({
    '@opentelemetry/instrumentation-fs': {
      enabled: false, // Disable file system instrumentation to reduce noise
    },
  }),

  // Enhanced Express instrumentation with detailed request/response tracking
  new ExpressInstrumentation({
    enabled: true,
    requestHook: (span: Span, info: { request: Request }) => {
      // Add custom attributes for Express requests
      span.setAttributes({
        'http.request.body.size':
          Number(info.request.get('content-length')) || 0,
        'http.request.user_agent': info.request.get('user-agent') || '',
        'http.request.remote_addr':
          info.request.ip || info.request.socket?.remoteAddress || '',
        'http.request.x_forwarded_for':
          info.request.get('x-forwarded-for') || '',
      });
    },
  }),

  // Enhanced HTTP instrumentation for outgoing requests
  new HttpInstrumentation({
    enabled: true,
    requestHook: (span: Span, request: IncomingMessage | OutgoingMessage) => {
      if ('getHeader' in request) {
        const contentLength = request.getHeader('content-length');
        span.setAttributes({
          'http.client.request.body.size': Number(contentLength) || 0,
        });
      }
    },
    responseHook: (span: Span, response: IncomingMessage | OutgoingMessage) => {
      if ('headers' in response) {
        const contentLength = response.headers['content-length'];
        span.setAttributes({
          'http.client.response.body.size': Number(contentLength) || 0,
        });
      }
    },
  }),

  // Prisma instrumentation for database operations
  new PrismaInstrumentation({
    middleware: true,
  }),
];

// Initialize NodeSDK with comprehensive configuration
const sdk = new NodeSDK({
  resource,
  traceExporter,
  metricReader,
  instrumentations,
});

console.log(
  `🚀 Initializing OpenTelemetry for ${serviceName} v${serviceVersion}`,
);
console.log(`📊 Traces endpoint: ${traceEndpoint}`);
console.log(`📈 Metrics endpoint: ${metricsEndpoint}`);

// Initialize the SDK and register with the OpenTelemetry API
sdk.start();

console.log('✅ OpenTelemetry SDK initialized successfully');

// Graceful shutdown handlers
const shutdown = async (signal: string) => {
  console.log(`📴 Received ${signal}, shutting down OpenTelemetry SDK...`);
  try {
    await sdk.shutdown();
    console.log('✅ OpenTelemetry SDK shut down successfully');
  } catch (error) {
    console.error('❌ Error shutting down OpenTelemetry SDK:', error);
  } finally {
    process.exit(0);
  }
};

// Handle various shutdown signals
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGUSR2', () => void shutdown('SIGUSR2')); // For nodemon

// Handle uncaught exceptions and unhandled rejections
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  void shutdown('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
  console.error('❌ Unhandled Rejection:', reason);
  void shutdown('unhandledRejection');
});
