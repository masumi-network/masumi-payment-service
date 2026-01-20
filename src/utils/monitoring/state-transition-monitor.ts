import { prisma } from '@/utils/db';
import { logger } from '@/utils/logger';
import {
  recordStateTransition,
  recordBlockchainJourney,
} from '@/utils/metrics';
import { PurchasingAction, PaymentAction } from '@/generated/prisma/client';
import { webhookEventsService } from '@/services/webhook-handler/webhook-events.service';

interface StateTransitionHistory {
  entityType: 'registration' | 'purchase' | 'payment';
  entityId: string;
  state: string;
  timestamp: Date;
  network?: string;
  paymentSourceId?: string;
}

export class StateTransitionMonitor {
  private stateHistory = new Map<string, StateTransitionHistory[]>();
  private lastCheck = new Date();

  constructor() {
    this.lastCheck = new Date();
  }

  async monitorAllStateTransitions() {
    try {
      logger.info('Starting state transition monitoring cycle');

      await Promise.all([
        this.monitorPurchaseStates(),
        this.monitorPaymentStates(),
      ]);

      this.lastCheck = new Date();
      logger.info('Completed state transition monitoring cycle');
    } catch (error) {
      logger.error('Error in state transition monitoring:', { error });
    }
  }

  private async monitorPurchaseStates() {
    try {
      const recentPurchases = await prisma.purchaseRequest.findMany({
        where: {
          updatedAt: { gte: this.lastCheck },
          NextAction: {
            requestedAction: {
              in: [
                PurchasingAction.FundsLockingRequested,
                PurchasingAction.FundsLockingInitiated,
                PurchasingAction.WaitingForExternalAction,
                PurchasingAction.WaitingForManualAction,
                PurchasingAction.SetRefundRequestedRequested,
                PurchasingAction.SetRefundRequestedInitiated,
                PurchasingAction.WithdrawRefundRequested,
                PurchasingAction.WithdrawRefundInitiated,
              ],
            },
          },
        },
        include: {
          PaymentSource: {
            select: { network: true, id: true },
          },
          NextAction: {
            select: { requestedAction: true },
          },
        },
        orderBy: { updatedAt: 'asc' },
      });

      for (const purchase of recentPurchases) {
        await this.processPurchaseStateChange(purchase);
      }

      logger.info(`Processed ${recentPurchases.length} purchase state changes`);
    } catch (error) {
      logger.error('Error monitoring purchase states:', { error });
    }
  }

  private async monitorPaymentStates() {
    try {
      const recentPayments = await prisma.paymentRequest.findMany({
        where: {
          updatedAt: { gte: this.lastCheck },
          NextAction: {
            requestedAction: {
              in: [
                PaymentAction.WithdrawRequested,
                PaymentAction.WithdrawInitiated,
                PaymentAction.SubmitResultRequested,
                PaymentAction.SubmitResultInitiated,
                PaymentAction.AuthorizeRefundRequested,
                PaymentAction.AuthorizeRefundInitiated,
                PaymentAction.WaitingForExternalAction,
                PaymentAction.WaitingForManualAction,
              ],
            },
          },
        },
        include: {
          PaymentSource: {
            select: { network: true, id: true },
          },
          NextAction: {
            select: { requestedAction: true },
          },
        },
        orderBy: { updatedAt: 'asc' },
      });

      for (const payment of recentPayments) {
        await this.processPaymentStateChange(payment);
      }

      logger.info(`Processed ${recentPayments.length} payment state changes`);
    } catch (error) {
      logger.error('Error monitoring payment states:', { error });
    }
  }

  private async processPurchaseStateChange(purchase: {
    id: string;
    updatedAt: Date;
    NextAction: { requestedAction: string };
    PaymentSource?: { network?: string; id?: string };
  }) {
    const entityKey = `purchase-${purchase.id}`;
    const currentState: StateTransitionHistory = {
      entityType: 'purchase',
      entityId: purchase.id,
      state: purchase.NextAction.requestedAction,
      timestamp: purchase.updatedAt,
      network: purchase.PaymentSource?.network,
      paymentSourceId: purchase.PaymentSource?.id,
    };

    const history = this.stateHistory.get(entityKey) || [];
    const lastState = history[history.length - 1];

    if (!lastState || lastState.state !== currentState.state) {
      history.push(currentState);
      this.stateHistory.set(entityKey, history);

      if (lastState) {
        const duration =
          currentState.timestamp.getTime() - lastState.timestamp.getTime();

        recordStateTransition(
          'purchase',
          lastState.state,
          currentState.state,
          duration,
          purchase.id,
          {
            network: currentState.network || 'unknown',
            payment_source_id: currentState.paymentSourceId || 'unknown',
          },
        );

        logger.info('Recorded purchase state transition', {
          purchaseId: purchase.id,
          fromState: lastState.state,
          toState: currentState.state,
          duration: `${duration}ms`,
        });

        // Trigger webhook for purchase state change
        try {
          await webhookEventsService.triggerPurchaseOnChainStatusChanged(
            purchase.id,
          );
        } catch (error) {
          logger.error('Failed to trigger purchase webhook', {
            purchaseId: purchase.id,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }

      if (
        this.isSignificantPurchaseState(currentState.state) &&
        history.length > 1
      ) {
        const firstState = history[0];
        const totalDuration =
          currentState.timestamp.getTime() - firstState.timestamp.getTime();

        recordBlockchainJourney(
          'purchase',
          totalDuration,
          currentState.state,
          purchase.id,
          {
            network: currentState.network || 'unknown',
            payment_source_id: currentState.paymentSourceId || 'unknown',
            total_transitions: history.length - 1,
          },
        );
      }
    }
  }

  private async processPaymentStateChange(payment: {
    id: string;
    updatedAt: Date;
    NextAction: { requestedAction: string };
    PaymentSource?: { network?: string; id?: string };
  }) {
    const entityKey = `payment-${payment.id}`;
    const currentState: StateTransitionHistory = {
      entityType: 'payment',
      entityId: payment.id,
      state: payment.NextAction.requestedAction,
      timestamp: payment.updatedAt,
      network: payment.PaymentSource?.network,
      paymentSourceId: payment.PaymentSource?.id,
    };

    const history = this.stateHistory.get(entityKey) || [];
    const lastState = history[history.length - 1];

    if (!lastState || lastState.state !== currentState.state) {
      history.push(currentState);
      this.stateHistory.set(entityKey, history);

      if (lastState) {
        const duration =
          currentState.timestamp.getTime() - lastState.timestamp.getTime();

        recordStateTransition(
          'payment',
          lastState.state,
          currentState.state,
          duration,
          payment.id,
          {
            network: currentState.network || 'unknown',
            payment_source_id: currentState.paymentSourceId || 'unknown',
          },
        );

        logger.info('Recorded payment state transition', {
          paymentId: payment.id,
          fromState: lastState.state,
          toState: currentState.state,
          duration: `${duration}ms`,
        });

        // Trigger webhook for payment state change
        try {
          await webhookEventsService.triggerPaymentOnChainStatusChanged(
            payment.id,
          );
        } catch (error) {
          logger.error('Failed to trigger payment webhook', {
            paymentId: payment.id,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }
    }
  }

  private isSignificantPurchaseState(state: string): boolean {
    return [
      'FundsLockingInitiated',
      'WaitingForExternalAction',
      'SetRefundRequestedInitiated',
      'WithdrawRefundInitiated',
    ].includes(state);
  }

  cleanupOldHistory(maxAgeHours = 24) {
    const cutoffTime = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000);

    for (const [key, history] of this.stateHistory.entries()) {
      const latestState = history[history.length - 1];
      if (latestState && latestState.timestamp < cutoffTime) {
        this.stateHistory.delete(key);
      }
    }
  }

  getMonitoringStats() {
    return {
      trackedEntities: this.stateHistory.size,
      lastCheckTime: this.lastCheck,
      memoryUsage: process.memoryUsage(),
    };
  }
}

export const stateTransitionMonitor = new StateTransitionMonitor();
