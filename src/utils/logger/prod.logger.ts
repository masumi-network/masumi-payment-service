import { createLogger, format, transports } from 'winston';
import { logs } from '@opentelemetry/api-logs';
import { CONFIG } from '../config';
const { combine, timestamp, errors, json } = format;

interface LogInfo {
	level: string;
	message: string;
	error?: Error;
	[key: string]: unknown;
}

// Custom transport that sends logs to OpenTelemetry
class OpenTelemetryTransport extends transports.Console {
	log(info: LogInfo, callback?: () => void) {
		// Fetch logger lazily so it uses the provider registered after SDK start
		const otelLogger = logs.getLogger('winston-otel-bridge', '1.0.0');

		// Extract known Winston internal fields, preserve all custom attributes
		const { level, message, timestamp: _winstonTimestamp, error, ...customAttributes } = info;

		const sanitizedAttributes: Record<string, string | number | boolean> = {};
		for (const [key, value] of Object.entries(customAttributes)) {
			if (value === undefined || value === null) continue;
			if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
				sanitizedAttributes[key] = value;
			} else if (typeof value === 'bigint') {
				sanitizedAttributes[key] = value.toString();
			} else if (value instanceof Date) {
				sanitizedAttributes[key] = value.toISOString();
			} else {
				try {
					sanitizedAttributes[key] = JSON.stringify(value);
				} catch {
					sanitizedAttributes[key] = '[non-serializable]';
				}
			}
		}

		otelLogger.emit({
			severityNumber: this.getSeverityNumber(level),
			severityText: level.toUpperCase(),
			body: String(message),
			attributes: {
				level: level,
				timestamp: new Date().toISOString(),
				service: CONFIG.OTEL_SERVICE_NAME,
				...sanitizedAttributes,
				...(error && {
					error_name: error.name,
					error_message: error.message,
					error_stack: error.stack,
				}),
			},
			timestamp: Date.now(),
		});
		const parentCallback = callback || (() => {});
		// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
		const parentLog = transports.Console.prototype.log as (info: LogInfo, callback: () => void) => void;
		parentLog.call(this, info, parentCallback);
	}

	private getSeverityNumber(level: string): number {
		switch (level) {
			case 'debug':
				return 5;
			case 'info':
				return 9;
			case 'warn':
				return 13;
			case 'error':
				return 17;
			case 'fatal':
				return 21;
			default:
				return 9;
		}
	}
}

function buildProdLogger() {
	return createLogger({
		format: combine(timestamp(), errors({ stack: true }), json()),
		defaultMeta: { service: 'payment-service' },
		transports: [new OpenTelemetryTransport()],
	});
}

export { buildProdLogger };
