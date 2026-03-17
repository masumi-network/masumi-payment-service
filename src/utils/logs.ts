import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import { logger as winstonLogger } from '@/utils/logger/';

// Fetch logger lazily so it uses the provider registered after SDK start
const getLogger = () => logs.getLogger('masumi-payment-logger', '1.0.0');

enum LogLevel {
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

interface ConsoleMetadata {
	[key: string]: string | number | boolean | Error | undefined;
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
	const metadata: ConsoleMetadata = {
		...(context ?? {}),
		...(attributes ?? {}),
	};

	if (error) {
		metadata.error = error;
	}

	return Object.keys(metadata).length > 0 ? metadata : undefined;
};

const emitConsoleLog = (level: LogLevel, message: string, metadata?: ConsoleMetadata) => {
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

export const logInfo = (message: string, context?: LogContext, attributes?: LogAttributes) => {
	emitLog(LogLevel.INFO, message, context, attributes);
};

export const logWarn = (message: string, context?: LogContext, attributes?: LogAttributes, error?: Error) => {
	emitLog(LogLevel.WARN, message, context, attributes, error);
};

export const logError = (message: string, context?: LogContext, attributes?: LogAttributes, error?: Error) => {
	emitLog(LogLevel.ERROR, message, context, attributes, error);
};
