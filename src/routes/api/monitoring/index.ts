import { adminAuthenticatedEndpointFactory } from '@/utils/security/auth/admin-authenticated';
import { z } from 'zod';
import { blockchainStateMonitorService } from '@/services/monitoring/blockchain-state-monitor.service';
import { checkRegistryData } from '@/utils/monitoring/diagnostic';

export const getMonitoringStatus = adminAuthenticatedEndpointFactory.build({
  method: 'get',
  input: z.object({}),
  output: z.object({
    monitoringStatus: z.object({
      isMonitoring: z.boolean(),
      stats: z
        .object({
          trackedEntities: z.number(),
          lastCheckTime: z.string(),
          memoryUsage: z.object({
            heapUsed: z.string(),
            heapTotal: z.string(),
            external: z.string(),
          }),
        })
        .nullable(),
    }),
  }),
  handler: async ({ options: _options }) => {
    const status = blockchainStateMonitorService.getStatus();

    return {
      monitoringStatus: {
        isMonitoring: status.isMonitoring,
        stats: status.stats
          ? {
              trackedEntities: status.stats.trackedEntities,
              lastCheckTime: status.stats.lastCheckTime.toISOString(),
              memoryUsage: {
                heapUsed: `${Math.round(status.stats.memoryUsage.heapUsed / 1024 / 1024)}MB`,
                heapTotal: `${Math.round(status.stats.memoryUsage.heapTotal / 1024 / 1024)}MB`,
                external: `${Math.round(status.stats.memoryUsage.external / 1024 / 1024)}MB`,
              },
            }
          : null,
      },
    };
  },
});

export const triggerMonitoringCycle = adminAuthenticatedEndpointFactory.build({
  method: 'post',
  input: z.object({}),
  output: z.object({
    message: z.string(),
    triggered: z.boolean(),
  }),
  handler: async ({ options: _options }) => {
    try {
      await blockchainStateMonitorService.forceMonitoringCycle();
      return {
        message: 'Manual monitoring cycle completed successfully',
        triggered: true,
      };
    } catch (error) {
      return {
        message: `Failed to trigger monitoring cycle: ${error instanceof Error ? error.message : String(error)}`,
        triggered: false,
      };
    }
  },
});

export const startMonitoring = adminAuthenticatedEndpointFactory.build({
  method: 'post',
  input: z.object({
    intervalMs: z.number().min(5000).max(300000).default(30000),
  }),
  output: z.object({
    message: z.string(),
    started: z.boolean(),
  }),
  handler: async ({ input }) => {
    try {
      await blockchainStateMonitorService.startMonitoring(input.intervalMs);
      return {
        message: `Monitoring service started with ${input.intervalMs}ms interval`,
        started: true,
      };
    } catch (error) {
      return {
        message: `Failed to start monitoring: ${error instanceof Error ? error.message : String(error)}`,
        started: false,
      };
    }
  },
});

export const stopMonitoring = adminAuthenticatedEndpointFactory.build({
  method: 'post',
  input: z.object({}),
  output: z.object({
    message: z.string(),
    stopped: z.boolean(),
  }),
  handler: async ({ options: _options }) => {
    try {
      blockchainStateMonitorService.stopMonitoring();
      return {
        message: 'Monitoring service stopped successfully',
        stopped: true,
      };
    } catch (error) {
      return {
        message: `Failed to stop monitoring: ${error instanceof Error ? error.message : String(error)}`,
        stopped: false,
      };
    }
  },
});

export const getDiagnostics = adminAuthenticatedEndpointFactory.build({
  method: 'get',
  input: z.object({}),
  output: z.object({
    recentCount: z.number(),
    recentRequests: z.array(
      z.object({
        id: z.string(),
        state: z.string(),
        updatedAt: z.string(),
        network: z.string().optional(),
      }),
    ),
    allStates: z.array(z.string()),
  }),
  handler: async ({ options: _options }) => {
    const diagnostic = await checkRegistryData();

    if (!diagnostic) {
      throw new Error('Failed to run diagnostics');
    }

    return {
      recentCount: diagnostic.recentCount,
      recentRequests: diagnostic.recent.map((reg) => ({
        id: reg.id,
        state: reg.state,
        updatedAt: reg.updatedAt.toISOString(),
        network: reg.PaymentSource?.network,
      })),
      allStates: diagnostic.allStates,
    };
  },
});
