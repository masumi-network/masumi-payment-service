import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import { logger as winstonLogger } from '@/utils/logger/';

// Fetch logger lazily so it uses the provider registered after SDK start
const getLogger = () => logs.getLogger('masumi-payment-logger', '1.0.0');

export enum LogLevel {
	DEBUG = 'debug',
	INFO = 'info',
	WARN = 'warn',
	ERROR = 'error',
	FATAL = 'fatal',
}

interface LogAttributes {
	[key: string]: string | number | boolean;
}

interface LogContext {
	userId?: string;
	sessionId?: string;
	requestId?: string;
	paymentId?: string;
	walletAddress?: string;
	txHash?: string;
	operation?: string;
	component?: string;
	[key: string]: string | number | boolean | undefined;
}

const getSeverityNumber = (level: LogLevel): SeverityNumber => {
	switch (level) {
		case LogLevel.DEBUG:
			return SeverityNumber.DEBUG;
		case LogLevel.INFO:
			return SeverityNumber.INFO;
		case LogLevel.WARN:
			return SeverityNumber.WARN;
		case LogLevel.ERROR:
			return SeverityNumber.ERROR;
		case LogLevel.FATAL:
			return SeverityNumber.FATAL;
		default:
			return SeverityNumber.INFO;
	}
};

const toConsoleMetadata = (context?: LogContext, attributes?: LogAttributes, error?: Error) => {
	const metadata: Record<string, unknown> = {
		...(context ?? {}),
		...(attributes ?? {}),
	};

	if (error) {
		metadata.error = error;
	}

	return Object.keys(metadata).length > 0 ? metadata : undefined;
};

const emitConsoleLog = (level: LogLevel, message: string, metadata?: Record<string, unknown>) => {
	switch (level) {
		case LogLevel.DEBUG:
			if (metadata) {
				winstonLogger.debug(message, metadata);
			} else {
				winstonLogger.debug(message);
			}
			return;
		case LogLevel.INFO:
			if (metadata) {
				winstonLogger.info(message, metadata);
			} else {
				winstonLogger.info(message);
			}
			return;
		case LogLevel.WARN:
			if (metadata) {
				winstonLogger.warn(message, metadata);
			} else {
				winstonLogger.warn(message);
			}
			return;
		case LogLevel.ERROR:
			if (metadata) {
				winstonLogger.error(message, metadata);
			} else {
				winstonLogger.error(message);
			}
			return;
		case LogLevel.FATAL:
			if (metadata) {
				winstonLogger.log('fatal', message, metadata);
			} else {
				winstonLogger.log('fatal', message);
			}
			return;
		default:
			if (metadata) {
				winstonLogger.info(message, metadata);
			} else {
				winstonLogger.info(message);
			}
	}
};

const emitLog = (level: LogLevel, message: string, context?: LogContext, attributes?: LogAttributes, error?: Error) => {
	const logAttributes: LogAttributes = {
		...attributes,
		...context,
		level,
		timestamp: new Date().toISOString(),
	};

	if (error) {
		logAttributes.error_name = error.name;
		logAttributes.error_message = error.message;
		logAttributes.error_stack = error.stack || '';
	}

	getLogger().emit({
		severityNumber: getSeverityNumber(level),
		severityText: level.toUpperCase(),
		body: message,
		attributes: logAttributes,
		timestamp: Date.now(),
	});

	emitConsoleLog(level, message, toConsoleMetadata(context, attributes, error));
};

export const logDebug = (message: string, context?: LogContext, attributes?: LogAttributes) => {
	emitLog(LogLevel.DEBUG, message, context, attributes);
};

export const logInfo = (message: string, context?: LogContext, attributes?: LogAttributes) => {
	emitLog(LogLevel.INFO, message, context, attributes);
};

export const logWarn = (message: string, context?: LogContext, attributes?: LogAttributes, error?: Error) => {
	emitLog(LogLevel.WARN, message, context, attributes, error);
};

export const logError = (message: string, context?: LogContext, attributes?: LogAttributes, error?: Error) => {
	emitLog(LogLevel.ERROR, message, context, attributes, error);
};

export const logFatal = (message: string, context?: LogContext, attributes?: LogAttributes, error?: Error) => {
	emitLog(LogLevel.FATAL, message, context, attributes, error);
};

export const logPaymentEvent = (
	event: string,
	paymentId: string,
	context?: Omit<LogContext, 'paymentId'>,
	attributes?: LogAttributes,
) => {
	logInfo(`Payment event: ${event}`, { ...context, paymentId }, attributes);
};

export const logWalletEvent = (
	event: string,
	walletAddress: string,
	context?: Omit<LogContext, 'walletAddress'>,
	attributes?: LogAttributes,
) => {
	logInfo(`Wallet event: ${event}`, { ...context, walletAddress }, attributes);
};

export const logTransactionEvent = (
	event: string,
	txHash: string,
	context?: Omit<LogContext, 'txHash'>,
	attributes?: LogAttributes,
) => {
	logInfo(`Transaction event: ${event}`, { ...context, txHash }, attributes);
};

export const logDatabaseEvent = (
	operation: string,
	table: string,
	context?: LogContext,
	attributes?: LogAttributes,
) => {
	logDebug(
		`Database operation: ${operation} on ${table}`,
		{ ...context, operation: `db_${operation}` },
		{ ...attributes, table },
	);
};

export const logApiRequest = (
	method: string,
	path: string,
	statusCode: number,
	duration: number,
	context?: LogContext,
	attributes?: LogAttributes,
) => {
	const level = statusCode >= 400 ? LogLevel.ERROR : LogLevel.INFO;
	emitLog(
		level,
		`${method} ${path} - ${statusCode}`,
		{ ...context, operation: 'api_request' },
		{
			...attributes,
			http_method: method,
			http_path: path,
			http_status_code: statusCode,
			request_duration_ms: duration,
		},
	);
};

export const logBusinessEvent = (
	event: string,
	data: Record<string, string | number | boolean>,
	context?: LogContext,
) => {
	logInfo(`Business event: ${event}`, context, data);
};

export const createLoggerWithContext = (defaultContext: LogContext) => {
	return {
		debug: (message: string, attributes?: LogAttributes) => logDebug(message, defaultContext, attributes),
		info: (message: string, attributes?: LogAttributes) => logInfo(message, defaultContext, attributes),
		warn: (message: string, attributes?: LogAttributes, error?: Error) =>
			logWarn(message, defaultContext, attributes, error),
		error: (message: string, attributes?: LogAttributes, error?: Error) =>
			logError(message, defaultContext, attributes, error),
		fatal: (message: string, attributes?: LogAttributes, error?: Error) =>
			logFatal(message, defaultContext, attributes, error),
	};
};
