import {
	monitoringStatusResponseSchema,
	startMonitoringResponseSchema,
	startMonitoringSchemaInput,
	stopMonitoringResponseSchema,
	triggerMonitoringCycleResponseSchema,
} from '@/routes/api/monitoring/schemas';
import { successResponse, type SwaggerRegistrarContext } from '../shared';

export function registerMonitoringPaths({ registry, apiKeyAuth }: SwaggerRegistrarContext) {
	registry.registerPath({
		method: 'get',
		path: '/monitoring',
		description: 'Gets the current status of the blockchain state monitoring service',
		summary: 'Get monitoring service status. (admin access required)',
		tags: ['monitoring'],
		security: [{ [apiKeyAuth.name]: [] }],
		responses: {
			200: successResponse('Monitoring service status', monitoringStatusResponseSchema, {
				MonitoringStatus: {
					isMonitoring: true,
					Stats: {
						trackedEntities: 42,
						PurchaseCursor: {
							timestamp: '2024-01-01T00:00:00.000Z',
							lastId: 'cuid_v2_auto_generated',
						},
						PaymentCursor: {
							timestamp: '2024-01-01T00:00:00.000Z',
							lastId: 'cuid_v2_auto_generated',
						},
						MemoryUsage: {
							heapUsed: '50MB',
							heapTotal: '100MB',
							external: '10MB',
						},
					},
				},
			}),
			401: {
				description: 'Unauthorized',
			},
			500: {
				description: 'Internal Server Error',
			},
		},
	});

	registry.registerPath({
		method: 'post',
		path: '/monitoring/trigger-cycle',
		description: 'Manually triggers a monitoring cycle to check blockchain state',
		summary: 'Trigger a manual monitoring cycle. (admin access required)',
		tags: ['monitoring'],
		security: [{ [apiKeyAuth.name]: [] }],
		responses: {
			200: successResponse('Monitoring cycle trigger result', triggerMonitoringCycleResponseSchema, {
				message: 'Manual monitoring cycle completed successfully',
				triggered: true,
			}),
			401: {
				description: 'Unauthorized',
			},
			500: {
				description: 'Internal Server Error',
			},
		},
	});

	registry.registerPath({
		method: 'post',
		path: '/monitoring/start',
		description: 'Starts the blockchain state monitoring service with a specified interval',
		summary: 'Start the monitoring service. (admin access required)',
		tags: ['monitoring'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			body: {
				description: 'Monitoring start configuration',
				content: {
					'application/json': {
						schema: startMonitoringSchemaInput.openapi({
							example: {
								intervalMs: 30000,
							},
						}),
					},
				},
			},
		},
		responses: {
			200: successResponse('Monitoring service start result', startMonitoringResponseSchema, {
				message: 'Monitoring service started with 30000ms interval',
				started: true,
			}),
			401: {
				description: 'Unauthorized',
			},
			409: {
				description: 'Conflict (monitoring service is already running)',
			},
			500: {
				description: 'Internal Server Error',
			},
		},
	});

	registry.registerPath({
		method: 'post',
		path: '/monitoring/stop',
		description: 'Stops the blockchain state monitoring service',
		summary: 'Stop the monitoring service. (admin access required)',
		tags: ['monitoring'],
		security: [{ [apiKeyAuth.name]: [] }],
		responses: {
			200: successResponse('Monitoring service stop result', stopMonitoringResponseSchema, {
				message: 'Monitoring service stopped successfully',
				stopped: true,
			}),
			401: {
				description: 'Unauthorized',
			},
			400: {
				description: 'Bad Request (monitoring service is not currently running)',
			},
			500: {
				description: 'Internal Server Error',
			},
		},
	});
}
