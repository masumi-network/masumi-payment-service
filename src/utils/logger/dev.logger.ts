import { createLogger, format, transports } from 'winston';
import type { TransformableInfo } from 'logform';
import { logs } from '@opentelemetry/api-logs';
import { CONFIG } from '../config';
const { combine, timestamp, printf, errors } = format;
const SPLAT = Symbol.for('splat');
const CAPTURED_SPLAT_ARGS_KEY = '__capturedSplatArgs';
const DEV_LOGGER_RESERVED_KEYS = new Set(['level', 'message', 'timestamp', 'stack', 'error', CAPTURED_SPLAT_ARGS_KEY]);
const ANSI_ESCAPE_CHARACTER = String.fromCharCode(27);
const ANSI_ESCAPE_PATTERN = new RegExp(`${ANSI_ESCAPE_CHARACTER}\\[[0-9;]*m`, 'g');

interface LogInfo extends TransformableInfo {
	level: string;
	message: unknown;
	error?: unknown;
	stack?: unknown;
	[CAPTURED_SPLAT_ARGS_KEY]?: unknown[];
}

// Strip ANSI escape codes that Winston's colorize format injects
const stripAnsi = (str: string) => str.replace(ANSI_ESCAPE_PATTERN, '');

const padAnsi = (value: string, width: number) => {
	const visibleLength = stripAnsi(value).length;
	return value + ' '.repeat(Math.max(0, width - visibleLength));
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

type ErrorDetails = {
	name?: string;
	message?: string;
	stack?: string;
	extra?: Record<string, unknown>;
};

const getErrorDetails = (value: unknown): ErrorDetails | null => {
	if (value instanceof Error) {
		const errorRecord = value as Error & Record<string, unknown>;
		const extra = Object.fromEntries(
			Object.entries(errorRecord).filter(([key]) => !['name', 'message', 'stack'].includes(key)),
		);
		return {
			name: value.name,
			message: value.message,
			stack: value.stack,
			extra: Object.keys(extra).length > 0 ? extra : undefined,
		};
	}

	if (!isRecord(value)) {
		return null;
	}

	const name = typeof value.name === 'string' ? value.name : undefined;
	const message = typeof value.message === 'string' ? value.message : undefined;
	const stack = typeof value.stack === 'string' ? value.stack : undefined;
	if (!name && !message && !stack) {
		return null;
	}

	const extra = Object.fromEntries(
		Object.entries(value).filter(([key]) => !['name', 'message', 'stack'].includes(key)),
	);
	return {
		name,
		message,
		stack,
		extra: Object.keys(extra).length > 0 ? extra : undefined,
	};
};

const logReplacer = (_key: string, value: unknown) => {
	if (typeof value === 'bigint') {
		return value.toString();
	}
	if (value instanceof Error) {
		return {
			name: value.name,
			message: value.message,
			stack: value.stack,
		};
	}
	return value;
};

const serializeForLog = (value: unknown) => {
	if (typeof value === 'string') {
		return value;
	}

	const compact = JSON.stringify(value, logReplacer);
	if (compact && compact.length <= 140) {
		return compact;
	}

	return JSON.stringify(value, logReplacer, 2) ?? String(value);
};

const buildIndentedBlock = (timestampValue: string, label: string, value: unknown) => {
	const indent = `${''.padStart(timestampValue.length)} │            │ `;
	const serialized = serializeForLog(value);
	const lines = serialized.split('\n');
	return lines.map((line, index) => `${indent}${index === 0 ? `${label}: ` : ''}${line}`);
};

const collectMetadata = (info: LogInfo) => {
	const metadata: Record<string, unknown> = Object.fromEntries(
		Object.entries(info).filter(([key]) => !DEV_LOGGER_RESERVED_KEYS.has(key)),
	);
	const capturedArgs = Array.isArray(info[CAPTURED_SPLAT_ARGS_KEY]) ? info[CAPTURED_SPLAT_ARGS_KEY] : [];

	for (const arg of capturedArgs) {
		if (!isRecord(arg) || getErrorDetails(arg)) {
			continue;
		}

		const isDuplicate = Object.entries(arg).every(([key, value]) => info[key] === value);
		if (!isDuplicate) {
			Object.assign(metadata, arg);
		}
	}

	return Object.keys(metadata).length > 0 ? metadata : null;
};

const extractInlineError = (info: LogInfo) => {
	const directError = getErrorDetails(info.error);
	if (directError) {
		return directError;
	}

	for (const arg of info[CAPTURED_SPLAT_ARGS_KEY] ?? []) {
		const error = getErrorDetails(arg);
		if (error) {
			return error;
		}
	}

	if (typeof info.stack === 'string' && info.stack.length > 0) {
		return {
			message: String(info.message),
			stack: info.stack,
		};
	}

	return null;
};

const captureSplatArgs = format((info: TransformableInfo) => {
	const rawSplatArgs: unknown = (info as TransformableInfo & { [key: symbol]: unknown })[SPLAT];
	if (Array.isArray(rawSplatArgs) && rawSplatArgs.length > 0) {
		(info as LogInfo)[CAPTURED_SPLAT_ARGS_KEY] = rawSplatArgs;
	}
	return info;
});

// Custom transport that sends logs to OpenTelemetry
class OpenTelemetryTransport extends transports.Console {
	log(info: LogInfo, callback?: () => void) {
		// Fetch logger lazily so it uses the provider registered after SDK start
		const otelLogger = logs.getLogger('winston-otel-bridge', '1.0.0');
		const rawLevel = stripAnsi(info.level);
		const error = getErrorDetails(info.error);

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

function buildDevLogger() {
	const logFormat = printf((info) => {
		const separator = '│';
		const levelBadge = `[${String(info.level)}]`;
		const paddedLevelBadge = padAnsi(levelBadge, 9);
		const rawLevel = stripAnsi(String(info.level));
		const shouldShowSupplementaryDetails = ['warn', 'error', 'fatal'].includes(rawLevel);
		const timestamp = String(info.timestamp);
		const lines = [`${timestamp} ${separator} ${paddedLevelBadge} ${separator} ${String(info.message)}`];
		const metadata = collectMetadata(info);
		const error = extractInlineError(info);

		if (shouldShowSupplementaryDetails && metadata) {
			lines.push(...buildIndentedBlock(timestamp, 'Meta', metadata));
		}

		if (shouldShowSupplementaryDetails && error?.message && !String(info.message).includes(error.message)) {
			lines.push(...buildIndentedBlock(timestamp, 'Error', error.message));
		}

		if (shouldShowSupplementaryDetails && error?.extra && Object.keys(error.extra).length > 0) {
			lines.push(...buildIndentedBlock(timestamp, 'Error Details', error.extra));
		}

		if (shouldShowSupplementaryDetails && error?.stack) {
			lines.push(...buildIndentedBlock(timestamp, 'Stack', error.stack));
		}

		return lines.join('\n');
	});

	return createLogger({
		format: combine(
			format.colorize({ all: false, level: true }),
			timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
			errors({ stack: true }),
			captureSplatArgs(),
			format.splat(),
			logFormat,
		),
		transports: [new OpenTelemetryTransport()],
	});
}

export { buildDevLogger };
