import { adminAuthenticatedEndpointFactory } from '@/utils/security/auth/admin-authenticated';
import { z } from '@/utils/zod-openapi';
import { blockchainStateMonitorService } from '@/services/monitoring/blockchain-state-monitor.service';
import createHttpError from 'http-errors';

export const monitoringStatusResponseSchema = z
  .object({
    monitoringStatus: z
      .object({
        isMonitoring: z
          .boolean()
          .describe(
            'Whether the blockchain state monitoring service is currently running',
          ),
        stats: z
          .object({
            trackedEntities: z
              .number()
              .describe(
                'Number of entities being tracked by the monitoring service',
              ),
            purchaseCursor: z
              .object({
                timestamp: z
                  .string()
                  .describe('Last processed purchase timestamp'),
                lastId: z
                  .string()
                  .nullable()
                  .describe('Last processed purchase ID'),
              })
              .describe('Cursor position for purchase diff tracking'),
            paymentCursor: z
              .object({
                timestamp: z
                  .string()
                  .describe('Last processed payment timestamp'),
                lastId: z
                  .string()
                  .nullable()
                  .describe('Last processed payment ID'),
              })
              .describe('Cursor position for payment diff tracking'),
            memoryUsage: z
              .object({
                heapUsed: z
                  .string()
                  .describe(
                    'Heap memory currently used by the monitoring service ',
                  ),
                heapTotal: z
                  .string()
                  .describe(
                    'Total heap memory allocated for the monitoring service ',
                  ),
                external: z
                  .string()
                  .describe('External memory used by the monitoring service '),
              })
              .describe('Memory usage statistics for the monitoring service'),
          })
          .nullable()
          .describe('Monitoring statistics. Null if monitoring is not active'),
      })
      .describe('Current status of the blockchain state monitoring service'),
  })
  .openapi('MonitoringStatus');

export const getMonitoringStatus = adminAuthenticatedEndpointFactory.build({
  method: 'get',
  input: z.object({}),
  output: monitoringStatusResponseSchema,
  handler: async () => {
    try {
      const status = blockchainStateMonitorService.getStatus();

      return {
        monitoringStatus: {
          isMonitoring: status.isMonitoring,
          stats: status.stats
            ? {
                trackedEntities: status.stats.trackedEntities,
                purchaseCursor: {
                  timestamp:
                    status.stats.purchaseCursor.timestamp.toISOString(),
                  lastId: status.stats.purchaseCursor.lastId ?? null,
                },
                paymentCursor: {
                  timestamp: status.stats.paymentCursor.timestamp.toISOString(),
                  lastId: status.stats.paymentCursor.lastId ?? null,
                },
                memoryUsage: {
                  heapUsed: `${Math.round(status.stats.memoryUsage.heapUsed / 1024 / 1024)}MB`,
                  heapTotal: `${Math.round(status.stats.memoryUsage.heapTotal / 1024 / 1024)}MB`,
                  external: `${Math.round(status.stats.memoryUsage.external / 1024 / 1024)}MB`,
                },
              }
            : null,
        },
      };
    } catch (error) {
      throw createHttpError(
        500,
        `Failed to get monitoring status: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },
});

export const triggerMonitoringCycleResponseSchema = z
  .object({
    message: z
      .string()
      .describe('Status message about the monitoring cycle trigger'),
    triggered: z
      .boolean()
      .describe('Whether the monitoring cycle was successfully triggered'),
  })
  .openapi('TriggeredMonitoringCycle');

export const triggerMonitoringCycle = adminAuthenticatedEndpointFactory.build({
  method: 'post',
  input: z.object({}),
  output: triggerMonitoringCycleResponseSchema,
  handler: async () => {
    try {
      await blockchainStateMonitorService.forceMonitoringCycle();
      return {
        message: 'Manual monitoring cycle completed successfully',
        triggered: true,
      };
    } catch (error) {
      throw createHttpError(
        500,
        `Failed to trigger monitoring cycle: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },
});

export const startMonitoringSchemaInput = z.object({
  intervalMs: z
    .number()
    .min(5000)
    .max(300000)
    .default(30000)
    .describe('Monitoring interval in milliseconds'),
});

export const startMonitoringResponseSchema = z
  .object({
    message: z
      .string()
      .describe('Status message about starting the monitoring service'),
    started: z
      .boolean()
      .describe('Whether the monitoring service was successfully started'),
  })
  .openapi('StartedMonitoring');

export const startMonitoring = adminAuthenticatedEndpointFactory.build({
  method: 'post',
  input: startMonitoringSchemaInput,
  output: startMonitoringResponseSchema,
  handler: async ({ input }) => {
    try {
      const status = blockchainStateMonitorService.getStatus();
      if (status.isMonitoring) {
        throw createHttpError(409, 'Monitoring service is already running');
      }
      await blockchainStateMonitorService.startMonitoring(input.intervalMs);
      return {
        message: `Monitoring service started with ${input.intervalMs}ms interval`,
        started: true,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      // Check if monitoring is already running
      if (errorMessage.includes('already running')) {
        throw createHttpError(409, errorMessage);
      }
      throw createHttpError(500, `Failed to start monitoring: ${errorMessage}`);
    }
  },
});

export const stopMonitoringResponseSchema = z
  .object({
    message: z
      .string()
      .describe('Status message about stopping the monitoring service'),
    stopped: z
      .boolean()
      .describe('Whether the monitoring service was successfully stopped'),
  })
  .openapi('StoppedMonitoring');

export const stopMonitoring = adminAuthenticatedEndpointFactory.build({
  method: 'post',
  input: z.object({}),
  output: stopMonitoringResponseSchema,
  handler: async () => {
    try {
      const status = blockchainStateMonitorService.getStatus();
      if (!status.isMonitoring) {
        throw createHttpError(
          400,
          'Monitoring service is not currently running',
        );
      }
      blockchainStateMonitorService.stopMonitoring();
      return {
        message: 'Monitoring service stopped successfully',
        stopped: true,
      };
    } catch (error) {
      // Re-throw HTTP errors as-is
      if (error && typeof error === 'object' && 'statusCode' in error) {
        throw error;
      }
      throw createHttpError(
        500,
        `Failed to stop monitoring: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },
});

export const getDiagnosticsResponseSchema = z
  .object({
    recentCount: z.number().describe('Number of recent registry requests'),
    allStates: z
      .array(z.object({ state: z.string(), count: z.number() }))
      .describe('List of all possible registry request states'),
  })
  .openapi('DiagnosticsData');
