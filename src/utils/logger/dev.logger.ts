import { createLogger, format, transports } from 'winston';
import { logs } from '@opentelemetry/api-logs';
import { CONFIG } from '../config';
const { combine, timestamp, printf, errors } = format;

interface LogInfo {
  level: string;
  message: string;
  error?: Error;
  [key: string]: unknown;
}

// Custom transport that sends logs to OpenTelemetry
class OpenTelemetryTransport extends transports.Console {
  private otelLogger = logs.getLogger('winston-otel-bridge', '1.0.0');

  log(info: LogInfo, callback?: () => void) {
    // Send to OpenTelemetry
    this.otelLogger.emit({
      severityNumber: this.getSeverityNumber(info.level),
      severityText: info.level.toUpperCase(),
      body: String(info.message),
      attributes: {
        level: info.level,
        timestamp: new Date().toISOString(),
        service: CONFIG.OTEL_SERVICE_NAME,
        ...(info.error && {
          error_name: info.error.name,
          error_message: info.error.message,
          error_stack: info.error.stack,
        }),
      },
      timestamp: Date.now(),
    });

    // Call parent log method for console output
    const parentCallback = callback || (() => {});
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const parentLog = transports.Console.prototype.log as (
      info: LogInfo,
      callback: () => void,
    ) => void;
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
    // Pad the level to maintain consistent width
    const paddedLevel = String(info.level).padEnd(7);

    // Handle error objects and their properties
    let mainMessage = String(info.message);
    if (info instanceof Error || (info.error && info.error instanceof Error)) {
      const error = info instanceof Error ? info : (info.error as Error);
      mainMessage = error.message || mainMessage;
    }
    const timestamp = String(info.timestamp);

    // Handle stack traces
    if (info.stack) {
      const stackLines = String(JSON.stringify(info.stack)).split('\n');

      return `${timestamp} ${separator} [${paddedLevel}] ${separator} ${mainMessage}\n${stackLines
        .slice(1)
        .map(
          (line: string) =>
            `${''.padStart(String(info.timestamp).length)} ${separator}            ${separator} ${line.trim()}`,
        )
        .join('\n')}`;
    }

    // Handle additional error properties
    let additionalInfo = '';
    if (typeof info.error === 'object' && info.error !== null) {
      const errorObj = info.error as Record<string, unknown>;
      const errorProps = Object.entries(errorObj)
        .filter(([key]) => key !== 'message' && key !== 'stack')
        .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
        .join(', ');
      if (errorProps) {
        additionalInfo = `\n${' '.padStart(timestamp.length)} ${separator}            ${separator} Additional Details: ${errorProps}`;
      }
    }

    return `${timestamp} ${separator} [${paddedLevel}] ${separator} ${mainMessage}${additionalInfo}`;
  });

  return createLogger({
    format: combine(
      format.colorize({ all: false, level: true }),
      timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      errors({ stack: true }),
      format.splat(),
      logFormat,
    ),
    transports: [new OpenTelemetryTransport()],
  });
}

export { buildDevLogger };
