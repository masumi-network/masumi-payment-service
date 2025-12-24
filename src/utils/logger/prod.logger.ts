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

    // Send to OpenTelemetry
    otelLogger.emit({
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

function buildProdLogger() {
  return createLogger({
    format: combine(timestamp(), errors({ stack: true }), json()),
    defaultMeta: { service: 'payment-service' },
    transports: [new OpenTelemetryTransport()],
  });
}

export { buildProdLogger };
