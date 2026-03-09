import { adminAuthenticatedEndpointFactory } from '@/utils/security/auth/admin-authenticated';
import { z } from '@/utils/zod-openapi';
import { blockchainStateMonitorService } from '@/services/monitoring/blockchain-state-monitor.service';
import createHttpError from 'http-errors';
import {
	monitoringStatusResponseSchema,
	startMonitoringResponseSchema,
	startMonitoringSchemaInput,
	stopMonitoringResponseSchema,
	triggerMonitoringCycleResponseSchema,
} from './schemas';

export const getMonitoringStatus = adminAuthenticatedEndpointFactory.build({
	method: 'get',
	input: z.object({}),
	output: monitoringStatusResponseSchema,
	handler: async () => {
		try {
			const status = blockchainStateMonitorService.getStatus();

			return {
				MonitoringStatus: {
					isMonitoring: status.isMonitoring,
					Stats: status.stats
						? {
								trackedEntities: status.stats.trackedEntities,
								PurchaseCursor: {
									timestamp: status.stats.purchaseCursor.timestamp.toISOString(),
									lastId: status.stats.purchaseCursor.lastId ?? null,
								},
								PaymentCursor: {
									timestamp: status.stats.paymentCursor.timestamp.toISOString(),
									lastId: status.stats.paymentCursor.lastId ?? null,
								},
								MemoryUsage: {
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
			const errorMessage = error instanceof Error ? error.message : String(error);
			// Check if monitoring is already running
			if (errorMessage.includes('already running')) {
				throw createHttpError(409, errorMessage);
			}
			throw createHttpError(500, `Failed to start monitoring: ${errorMessage}`);
		}
	},
});

export const stopMonitoring = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: z.object({}),
	output: stopMonitoringResponseSchema,
	handler: async () => {
		try {
			const status = blockchainStateMonitorService.getStatus();
			if (!status.isMonitoring) {
				throw createHttpError(400, 'Monitoring service is not currently running');
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

export {
	getDiagnosticsResponseSchema,
	monitoringStatusResponseSchema,
	startMonitoringResponseSchema,
	startMonitoringSchemaInput,
	stopMonitoringResponseSchema,
	triggerMonitoringCycleResponseSchema,
} from './schemas';
