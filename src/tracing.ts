import process from 'process';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { Span } from '@opentelemetry/api';
import { IncomingMessage, OutgoingMessage } from 'http';
import { Request } from 'express';
import { PrismaInstrumentation } from '@prisma/instrumentation';
import { PrismaOutlierFilterSpanExporter } from '@/utils/tracing/prisma-outlier-filter-exporter';
import { CONFIG } from './utils/config';
import { logInfo, logError } from './utils/logs';
import { logger } from './utils/logger';

export async function setupTracing() {
	// Service information
	const serviceName = CONFIG.OTEL_SERVICE_NAME;
	const serviceVersion = CONFIG.OTEL_SERVICE_VERSION;

	// OTLP endpoints
	const otlpEndpoint = CONFIG.OTEL_EXPORTER_OTLP_ENDPOINT;
	if (!otlpEndpoint) {
		logger.warn('************************** OTEL is not configured ******************************');
		return;
	}
	const traceEndpoint = CONFIG.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || `${otlpEndpoint}/v1/traces`;
	const metricsEndpoint = CONFIG.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT || `${otlpEndpoint}/v1/metrics`;
	const logsEndpoint = CONFIG.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT || `${otlpEndpoint}/v1/logs`;

	// Resource configuration
	const resource = resourceFromAttributes({
		[ATTR_SERVICE_NAME]: serviceName,
		[ATTR_SERVICE_VERSION]: serviceVersion,
	});

	// Build headers from environment variables
	const headers: Record<string, string> = {};
	if (CONFIG.SIGNOZ_INGESTION_KEY) {
		headers['signoz-ingestion-key'] = CONFIG.SIGNOZ_INGESTION_KEY;
	}

	// Trace exporter: wrap OTLP with Prisma outlier filter to reduce volume
	const otlpTraceExporter = new OTLPTraceExporter({
		url: traceEndpoint,
		headers,
	});
	const traceExporter = new PrismaOutlierFilterSpanExporter(otlpTraceExporter, {
		outlierThresholdMs: CONFIG.OTEL_PRISMA_OUTLIER_THRESHOLD_MS,
		maxPrismaSpansPerMinute: CONFIG.OTEL_PRISMA_MAX_SPANS_PER_MINUTE,
	});

	// Metrics exporter configuration
	const metricExporter = new OTLPMetricExporter({
		url: metricsEndpoint,
		headers,
	});

	// Logs exporter configuration
	const logExporter = new OTLPLogExporter({
		url: logsEndpoint,
		headers,
	});

	// Metric reader with 15-second collection interval
	const metricReader = new PeriodicExportingMetricReader({
		exporter: metricExporter,
		exportIntervalMillis: 15000,
	});

	// Log processor configuration
	const logRecordProcessor = new BatchLogRecordProcessor(logExporter);

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
					'http.request.body.size': Number(info.request.get('content-length')) || 0,
					'http.request.user_agent': info.request.get('user-agent') || '',
					'http.request.remote_addr': info.request.ip || info.request.socket?.remoteAddress || '',
					'http.request.x_forwarded_for': info.request.get('x-forwarded-for') || '',
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
		new PrismaInstrumentation(),
	];

	// Initialize NodeSDK with comprehensive configuration
	const sdk = new NodeSDK({
		resource,
		traceExporter,
		metricReader,
		logRecordProcessor,
		instrumentations,
	});

	logInfo(`🚀 Initializing OpenTelemetry for ${serviceName} v${serviceVersion}`, {
		component: 'tracing',
		operation: 'initialization',
	});
	logInfo(`📊 Traces endpoint: ${traceEndpoint}`, {
		component: 'tracing',
		operation: 'configuration',
	});
	logInfo(`📈 Metrics endpoint: ${metricsEndpoint}`, {
		component: 'tracing',
		operation: 'configuration',
	});
	logInfo(`📝 Logs endpoint: ${logsEndpoint}`, {
		component: 'tracing',
		operation: 'configuration',
	});

	// Initialize the SDK and register with the OpenTelemetry API
	sdk.start();

	logInfo('✅ OpenTelemetry SDK initialized successfully', {
		component: 'tracing',
		operation: 'initialization',
	});

	// Graceful shutdown handlers
	const shutdown = async (signal: string) => {
		logInfo(`📴 Received ${signal}, shutting down OpenTelemetry SDK...`, {
			component: 'tracing',
			operation: 'shutdown',
		});
		try {
			await sdk.shutdown();
			logInfo('✅ OpenTelemetry SDK shut down successfully', {
				component: 'tracing',
				operation: 'shutdown',
			});
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			logError('❌ Error shutting down OpenTelemetry SDK', { component: 'tracing', operation: 'shutdown' }, {}, err);
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
		logError('❌ Uncaught Exception', { component: 'tracing', operation: 'error_handling' }, {}, error);
		void shutdown('uncaughtException');
	});

	process.on('unhandledRejection', (reason) => {
		const error = reason instanceof Error ? reason : new Error(String(reason));
		logError('❌ Unhandled Rejection', { component: 'tracing', operation: 'error_handling' }, {}, error);
		void shutdown('unhandledRejection');
	});
}
