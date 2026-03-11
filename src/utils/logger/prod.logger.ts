import { createLogger, format, transports } from 'winston';
import type { TransformableInfo } from 'logform';
import { logs } from '@opentelemetry/api-logs';
import { CONFIG } from '../config';
const { combine, timestamp, errors, json } = format;

type ProdLoggerInfo = TransformableInfo & {
	error?: unknown;
};

// Strip ANSI escape codes that Winston's colorize format may inject
const ANSI_ESCAPE_CHARACTER = String.fromCharCode(27);
const ANSI_ESCAPE_PATTERN = new RegExp(`${ANSI_ESCAPE_CHARACTER}\\[[0-9;]*m`, 'g');
const stripAnsi = (str: string) => str.replace(ANSI_ESCAPE_PATTERN, '');

// Custom transport that sends logs to OpenTelemetry
class OpenTelemetryTransport extends transports.Console {
	log(info: ProdLoggerInfo, callback?: () => void) {
		// Fetch logger lazily so it uses the provider registered after SDK start
		const otelLogger = logs.getLogger('winston-otel-bridge', '1.0.0');
		const rawLevel = stripAnsi(info.level);
		const error = info.error instanceof Error ? info.error : undefined;

		// Send to OpenTelemetry
		otelLogger.emit({
			severityNumber: this.getSeverityNumber(rawLevel),
			severityText: rawLevel.toUpperCase(),
			body: String(info.message),
			attributes: {
				level: rawLevel,
				timestamp: new Date().toISOString(),
				service: CONFIG.OTEL_SERVICE_NAME,
				...(error && {
					error_name: error.name,
					error_message: error.message,
					error_stack: error.stack,
				}),
			},
			timestamp: Date.now(),
		});

		// Call parent log method for console output
		const parentCallback = callback || (() => {});
		// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
		const parentLog = transports.Console.prototype.log as (info: ProdLoggerInfo, callback: () => void) => void;
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
