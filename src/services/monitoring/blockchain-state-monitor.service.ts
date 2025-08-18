import { logger } from '@/utils/logger';
import { stateTransitionMonitor } from '@/utils/monitoring/state-transition-monitor';

export class BlockchainStateMonitorService {
  private monitoringInterval: NodeJS.Timeout | null = null;
  private isMonitoring = false;

  /**
   * Start the blockchain state monitoring service
   * @param intervalMs - Monitoring interval in milliseconds (default: 30 seconds)
   */
  async startMonitoring(intervalMs: number = 30000) {
    if (this.isMonitoring) {
      logger.warn('Blockchain state monitoring is already running');
      return;
    }

    logger.info('Starting blockchain state monitoring service', {
      intervalMs,
      intervalSeconds: intervalMs / 1000,
    });

    this.isMonitoring = true;

    // Run initial monitoring cycle
    await this.runMonitoringCycle();

    this.monitoringInterval = setInterval(() => {
      void this.runMonitoringCycle();
    }, intervalMs);

    logger.info('Blockchain state monitoring service started successfully');
  }

  stopMonitoring() {
    if (!this.isMonitoring) {
      logger.warn('Blockchain state monitoring is not running');
      return;
    }

    logger.info('Stopping blockchain state monitoring service');

    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }

    this.isMonitoring = false;
    logger.info('Blockchain state monitoring service stopped');
  }

  private async runMonitoringCycle() {
    const cycleStartTime = Date.now();

    try {
      logger.debug('Starting blockchain state monitoring cycle');

      // Monitor all state transitions
      await stateTransitionMonitor.monitorAllStateTransitions();

      // Cleanup old history to prevent memory leaks
      stateTransitionMonitor.cleanupOldHistory(24);

      const cycleDuration = Date.now() - cycleStartTime;
      const stats = stateTransitionMonitor.getMonitoringStats();

      logger.debug('Completed blockchain state monitoring cycle', {
        cycleDuration: `${cycleDuration}ms`,
        trackedEntities: stats.trackedEntities,
        memoryUsage: {
          heapUsed: `${Math.round(stats.memoryUsage.heapUsed / 1024 / 1024)}MB`,
          heapTotal: `${Math.round(stats.memoryUsage.heapTotal / 1024 / 1024)}MB`,
        },
      });
    } catch (error) {
      logger.error('Error in blockchain state monitoring cycle', {
        error: error instanceof Error ? error.message : String(error),
        cycleDuration: `${Date.now() - cycleStartTime}ms`,
      });
    }
  }

  getStatus() {
    return {
      isMonitoring: this.isMonitoring,
      stats: this.isMonitoring
        ? stateTransitionMonitor.getMonitoringStats()
        : null,
    };
  }

  async forceMonitoringCycle() {
    logger.info('Running manual blockchain state monitoring cycle');
    await this.runMonitoringCycle();
  }
}

export const blockchainStateMonitorService =
  new BlockchainStateMonitorService();
