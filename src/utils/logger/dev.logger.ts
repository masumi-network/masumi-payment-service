import { createLogger, format, transports } from 'winston';
import { logs } from '@opentelemetry/api-logs';
import { CONFIG } from '../config';
import {
	getOwnEntries,
	getOwnString,
	getOwnValue,
	isPlainObject,
	type RuntimeObject,
	type RuntimePropertyValue,
} from '@/utils/object-properties';

const { combine, timestamp, printf, errors } = format;
const SPLAT = Symbol.for('splat');
const CAPTURED_SPLAT_ARGS_KEY = '__capturedSplatArgs';
const DEV_LOGGER_RESERVED_KEYS = new Set(['level', 'message', 'timestamp', 'stack', 'error', CAPTURED_SPLAT_ARGS_KEY]);
const ERROR_RESERVED_KEYS = new Set(['name', 'message', 'stack']);
const ANSI_ESCAPE_CHARACTER = String.fromCharCode(27);
const ANSI_ESCAPE_PATTERN = new RegExp(`${ANSI_ESCAPE_CHARACTER}\\[[0-9;]*m`, 'g');

type LoggerInfoValue = RuntimePropertyValue | unknown[];

type DevLoggerInfo = {
	level: string;
	message: LoggerInfoValue;
	timestamp?: string;
	[CAPTURED_SPLAT_ARGS_KEY]?: unknown[];
	error?: LoggerInfoValue;
	stack?: LoggerInfoValue;
	[key: string]: LoggerInfoValue;
	[key: symbol]: LoggerInfoValue | undefined;
};

type ErrorDetails = {
	name?: string;
	message?: string;
	stack?: string;
	extra?: RuntimeObject;
};

// Strip ANSI escape codes that Winston's colorize format injects
const stripAnsi = (str: string) => str.replace(ANSI_ESCAPE_PATTERN, '');

const padAnsi = (value: string, width: number) => {
	const visibleLength = stripAnsi(value).length;
	return value + ' '.repeat(Math.max(0, width - visibleLength));
};

const buildRuntimeObject = (entries: Array<readonly [string, RuntimePropertyValue]>): RuntimeObject | null => {
	const metadata: RuntimeObject = {};

	for (const [key, value] of entries) {
		metadata[key] = value;
	}

	return Object.keys(metadata).length > 0 ? metadata : null;
};

const getErrorDetails = (value: unknown): ErrorDetails | null => {
	if (value instanceof Error) {
		const extra = buildRuntimeObject(getOwnEntries(value).filter(([key]) => !ERROR_RESERVED_KEYS.has(key)));
		return {
			name: value.name,
			message: value.message,
			stack: value.stack,
			extra: extra ?? undefined,
		};
	}

	if (!isPlainObject(value)) {
		return null;
	}

	const name = getOwnString(value, 'name');
	const message = getOwnString(value, 'message');
	const stack = getOwnString(value, 'stack');
	if (!name && !message && !stack) {
		return null;
	}

	const extra = buildRuntimeObject(getOwnEntries(value).filter(([key]) => !ERROR_RESERVED_KEYS.has(key)));
	return {
		name,
		message,
		stack,
		extra: extra ?? undefined,
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

const getCapturedSplatArgs = (info: DevLoggerInfo): unknown[] => {
	const capturedArgs = info[CAPTURED_SPLAT_ARGS_KEY];
	return Array.isArray(capturedArgs) ? capturedArgs : [];
};

const collectMetadata = (info: DevLoggerInfo) => {
	const metadata: RuntimeObject = {};

	for (const [key, value] of getOwnEntries(info)) {
		if (!DEV_LOGGER_RESERVED_KEYS.has(key)) {
			metadata[key] = value;
		}
	}

	for (const arg of getCapturedSplatArgs(info)) {
		if (!isPlainObject(arg) || getErrorDetails(arg)) {
			continue;
		}

		const isDuplicate = getOwnEntries(arg).every(([key, value]) => getOwnValue(info, key) === value);
		if (!isDuplicate) {
			Object.assign(metadata, arg);
		}
	}

	return Object.keys(metadata).length > 0 ? metadata : null;
};

const extractInlineError = (info: DevLoggerInfo) => {
	const directError = getErrorDetails(info.error);
	if (directError) {
		return directError;
	}

	for (const arg of getCapturedSplatArgs(info)) {
		const error = getErrorDetails(arg);
		if (error) {
			return error;
		}
	}

	const stack = typeof info.stack === 'string' && info.stack.length > 0 ? info.stack : undefined;
	if (stack) {
		return {
			message: serializeForLog(info.message),
			stack,
			extra: undefined,
		};
	}

	return null;
};

const captureSplatArgs = format((info) => {
	const rawSplatArgs = getOwnValue(info, SPLAT);
	if (Array.isArray(rawSplatArgs) && rawSplatArgs.length > 0) {
		(info as DevLoggerInfo)[CAPTURED_SPLAT_ARGS_KEY] = rawSplatArgs;
	}
	return info;
});

// Custom transport that sends logs to OpenTelemetry
class OpenTelemetryTransport extends transports.Console {
	log(info: DevLoggerInfo, callback?: () => void) {
		// Fetch logger lazily so it uses the provider registered after SDK start
		const otelLogger = logs.getLogger('winston-otel-bridge', '1.0.0');
		const rawLevel = stripAnsi(info.level);
		const error = getErrorDetails(info.error);

		// Send to OpenTelemetry
		otelLogger.emit({
			severityNumber: this.getSeverityNumber(rawLevel),
			severityText: rawLevel.toUpperCase(),
			body: serializeForLog(info.message),
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
		const parentLog = transports.Console.prototype.log as (info: DevLoggerInfo, callback: () => void) => void;
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
		const timestampValue = String(info.timestamp);
		const devInfo = info as DevLoggerInfo;
		const lines = [`${timestampValue} ${separator} ${paddedLevelBadge} ${separator} ${String(info.message)}`];
		const metadata = collectMetadata(devInfo);
		const error = extractInlineError(devInfo);

		if (shouldShowSupplementaryDetails && metadata) {
			lines.push(...buildIndentedBlock(timestampValue, 'Meta', metadata));
		}

		if (shouldShowSupplementaryDetails && error?.message && !String(info.message).includes(error.message)) {
			lines.push(...buildIndentedBlock(timestampValue, 'Error', error.message));
		}

		if (shouldShowSupplementaryDetails && error?.extra && Object.keys(error.extra).length > 0) {
			lines.push(...buildIndentedBlock(timestampValue, 'Error Details', error.extra));
		}

		if (shouldShowSupplementaryDetails && error?.stack) {
			lines.push(...buildIndentedBlock(timestampValue, 'Stack', error.stack));
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
