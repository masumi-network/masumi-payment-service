import { z } from '@/utils/zod-openapi';

export const monitoringStatusResponseSchema = z
	.object({
		MonitoringStatus: z
			.object({
				isMonitoring: z.boolean().describe('Whether the blockchain state monitoring service is currently running'),
				Stats: z
					.object({
						trackedEntities: z.number().describe('Number of entities being tracked by the monitoring service'),
						PurchaseCursor: z
							.object({
								timestamp: z.string().describe('Last processed purchase timestamp'),
								lastId: z.string().nullable().describe('Last processed purchase ID'),
							})
							.describe('Cursor position for purchase diff tracking'),
						PaymentCursor: z
							.object({
								timestamp: z.string().describe('Last processed payment timestamp'),
								lastId: z.string().nullable().describe('Last processed payment ID'),
							})
							.describe('Cursor position for payment diff tracking'),
						MemoryUsage: z
							.object({
								heapUsed: z.string().describe('Heap memory currently used by the monitoring service '),
								heapTotal: z.string().describe('Total heap memory allocated for the monitoring service '),
								external: z.string().describe('External memory used by the monitoring service '),
							})
							.describe('Memory usage statistics for the monitoring service'),
					})
					.nullable()
					.describe('Monitoring statistics. Null if monitoring is not active'),
			})
			.describe('Current status of the blockchain state monitoring service'),
	})
	.openapi('MonitoringStatus');

export const triggerMonitoringCycleResponseSchema = z
	.object({
		message: z.string().describe('Status message about the monitoring cycle trigger'),
		triggered: z.boolean().describe('Whether the monitoring cycle was successfully triggered'),
	})
	.openapi('TriggeredMonitoringCycle');

export const startMonitoringSchemaInput = z.object({
	intervalMs: z.number().min(5000).max(300000).default(30000).describe('Monitoring interval in milliseconds'),
});

export const startMonitoringResponseSchema = z
	.object({
		message: z.string().describe('Status message about starting the monitoring service'),
		started: z.boolean().describe('Whether the monitoring service was successfully started'),
	})
	.openapi('StartedMonitoring');

export const stopMonitoringResponseSchema = z
	.object({
		message: z.string().describe('Status message about stopping the monitoring service'),
		stopped: z.boolean().describe('Whether the monitoring service was successfully stopped'),
	})
	.openapi('StoppedMonitoring');

export const getDiagnosticsResponseSchema = z
	.object({
		recentCount: z.number().describe('Number of recent registry requests'),
		AllStates: z
			.array(z.object({ state: z.string(), count: z.number() }))
			.describe('List of all possible registry request states'),
	})
	.openapi('DiagnosticsData');
