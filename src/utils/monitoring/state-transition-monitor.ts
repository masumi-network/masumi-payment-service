import { prisma } from '@/utils/db';
import { logger } from '@/utils/logger';
import { recordStateTransition, recordBlockchainJourney } from '@/utils/metrics';
import { PurchasingAction, PaymentAction, Prisma } from '@/generated/prisma/client';
import { webhookEventsService } from '@/services/webhook-handler/webhook-events.service';

interface EntityStateCache {
  currentState: string;
  currentTimestamp: Date;
  firstSeenTimestamp: Date;
  transitionCount: number;
  network?: string;
  paymentSourceId?: string;
}

interface DiffCursor {
  timestamp: Date;
  lastId?: string;
}

export class StateTransitionMonitor {
  private static readonly BATCH_SIZE = 100;

  private purchaseStateCache = new Map<string, EntityStateCache>();
  private paymentStateCache = new Map<string, EntityStateCache>();

  private purchaseCursor: DiffCursor = { timestamp: new Date(0) };
  private paymentCursor: DiffCursor = { timestamp: new Date(0) };

  private static readonly MONITORED_PURCHASE_ACTIONS = new Set<PurchasingAction>([
    PurchasingAction.FundsLockingRequested,
    PurchasingAction.FundsLockingInitiated,
    PurchasingAction.WaitingForExternalAction,
    PurchasingAction.WaitingForManualAction,
    PurchasingAction.SetRefundRequestedRequested,
    PurchasingAction.SetRefundRequestedInitiated,
    PurchasingAction.WithdrawRefundRequested,
    PurchasingAction.WithdrawRefundInitiated,
  ]);

  private static readonly MONITORED_PAYMENT_ACTIONS = new Set<PaymentAction>([
    PaymentAction.WithdrawRequested,
    PaymentAction.WithdrawInitiated,
    PaymentAction.SubmitResultRequested,
    PaymentAction.SubmitResultInitiated,
    PaymentAction.AuthorizeRefundRequested,
    PaymentAction.AuthorizeRefundInitiated,
    PaymentAction.WaitingForExternalAction,
    PaymentAction.WaitingForManualAction,
  ]);

  async monitorAllStateTransitions() {
    try {
      logger.info('Starting state transition monitoring cycle');

      await Promise.all([this.monitorPurchaseStates(), this.monitorPaymentStates()]);

      logger.info('Completed state transition monitoring cycle');
    } catch (error) {
      logger.error('Error in state transition monitoring:', { error });
    }
  }

  private buildPurchaseDiffWhere(cursor: DiffCursor): Prisma.PurchaseRequestWhereInput {
    const { timestamp: since, lastId: sinceId } = cursor;

    return sinceId != null
      ? {
          OR: [
            { nextActionOrOnChainStateOrResultLastChangedAt: { gt: since } },
            {
              nextActionOrOnChainStateOrResultLastChangedAt: since,
              id: { gt: sinceId },
            },
          ],
        }
      : { nextActionOrOnChainStateOrResultLastChangedAt: { gt: since } };
  }

  private buildPaymentDiffWhere(cursor: DiffCursor): Prisma.PaymentRequestWhereInput {
    const { timestamp: since, lastId: sinceId } = cursor;

    return sinceId != null
      ? {
          OR: [
            { nextActionOrOnChainStateOrResultLastChangedAt: { gt: since } },
            {
              nextActionOrOnChainStateOrResultLastChangedAt: since,
              id: { gt: sinceId },
            },
          ],
        }
      : { nextActionOrOnChainStateOrResultLastChangedAt: { gt: since } };
  }

  private async monitorPurchaseStates() {
    try {
      let hasMore = true;
      let processedCount = 0;
      let skippedCount = 0;

      while (hasMore) {
        const purchases = await prisma.purchaseRequest.findMany({
          where: this.buildPurchaseDiffWhere(this.purchaseCursor),
          orderBy: [{ nextActionOrOnChainStateOrResultLastChangedAt: 'asc' }, { id: 'asc' }],
          take: StateTransitionMonitor.BATCH_SIZE,
          include: {
            PaymentSource: { select: { network: true, id: true } },
            NextAction: { select: { requestedAction: true } },
          },
        });

        for (const purchase of purchases) {
          this.purchaseCursor = {
            timestamp: purchase.nextActionOrOnChainStateOrResultLastChangedAt,
            lastId: purchase.id,
          };

          if (
            !StateTransitionMonitor.MONITORED_PURCHASE_ACTIONS.has(
              purchase.NextAction.requestedAction,
            )
          ) {
            skippedCount++;
            continue;
          }

          await this.processPurchaseStateChange(purchase);
          processedCount++;
        }

        hasMore = purchases.length === StateTransitionMonitor.BATCH_SIZE;
      }

      logger.info(
        `Processed ${processedCount} purchase state changes (skipped ${skippedCount} non-monitored)`,
      );
    } catch (error) {
      logger.error('Error monitoring purchase states:', { error });
    }
  }

  private async monitorPaymentStates() {
    try {
      let hasMore = true;
      let processedCount = 0;
      let skippedCount = 0;

      while (hasMore) {
        const payments = await prisma.paymentRequest.findMany({
          where: this.buildPaymentDiffWhere(this.paymentCursor),
          orderBy: [{ nextActionOrOnChainStateOrResultLastChangedAt: 'asc' }, { id: 'asc' }],
          take: StateTransitionMonitor.BATCH_SIZE,
          include: {
            PaymentSource: { select: { network: true, id: true } },
            NextAction: { select: { requestedAction: true } },
          },
        });

        for (const payment of payments) {
          this.paymentCursor = {
            timestamp: payment.nextActionOrOnChainStateOrResultLastChangedAt,
            lastId: payment.id,
          };

          if (
            !StateTransitionMonitor.MONITORED_PAYMENT_ACTIONS.has(
              payment.NextAction.requestedAction,
            )
          ) {
            skippedCount++;
            continue;
          }

          await this.processPaymentStateChange(payment);
          processedCount++;
        }

        hasMore = payments.length === StateTransitionMonitor.BATCH_SIZE;
      }

      logger.info(
        `Processed ${processedCount} payment state changes (skipped ${skippedCount} non-monitored)`,
      );
    } catch (error) {
      logger.error('Error monitoring payment states:', { error });
    }
  }

  private async processPurchaseStateChange(purchase: {
    id: string;
    nextActionOrOnChainStateOrResultLastChangedAt: Date;
    NextAction: { requestedAction: string };
    PaymentSource?: { network?: string; id?: string };
  }) {
    const cacheKey = purchase.id;
    const cached = this.purchaseStateCache.get(cacheKey);
    const currentState = purchase.NextAction.requestedAction;
    const currentTimestamp = purchase.nextActionOrOnChainStateOrResultLastChangedAt;

    if (cached && cached.currentState === currentState) {
      return;
    }

    const newCache: EntityStateCache = {
      currentState,
      currentTimestamp,
      firstSeenTimestamp: cached?.firstSeenTimestamp ?? currentTimestamp,
      transitionCount: (cached?.transitionCount ?? 0) + (cached ? 1 : 0),
      network: purchase.PaymentSource?.network,
      paymentSourceId: purchase.PaymentSource?.id,
    };

    this.purchaseStateCache.set(cacheKey, newCache);

    if (cached) {
      const duration = currentTimestamp.getTime() - cached.currentTimestamp.getTime();

      recordStateTransition('purchase', cached.currentState, currentState, duration, purchase.id, {
        network: newCache.network || 'unknown',
        payment_source_id: newCache.paymentSourceId || 'unknown',
      });

      logger.info('Recorded purchase state transition', {
        purchaseId: purchase.id,
        fromState: cached.currentState,
        toState: currentState,
        duration: `${duration}ms`,
      });

      // Trigger webhook for purchase state change
      try {
        await webhookEventsService.triggerPurchaseOnChainStatusChanged(purchase.id);
      } catch (error) {
        logger.error('Failed to trigger purchase webhook', {
          purchaseId: purchase.id,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    if (this.isSignificantPurchaseState(currentState) && newCache.transitionCount > 0) {
      const totalDuration = currentTimestamp.getTime() - newCache.firstSeenTimestamp.getTime();

      recordBlockchainJourney('purchase', totalDuration, currentState, purchase.id, {
        network: newCache.network || 'unknown',
        payment_source_id: newCache.paymentSourceId || 'unknown',
        total_transitions: newCache.transitionCount,
      });
    }
  }

  private async processPaymentStateChange(payment: {
    id: string;
    nextActionOrOnChainStateOrResultLastChangedAt: Date;
    NextAction: { requestedAction: string };
    PaymentSource?: { network?: string; id?: string };
  }) {
    const cacheKey = payment.id;
    const cached = this.paymentStateCache.get(cacheKey);
    const currentState = payment.NextAction.requestedAction;
    const currentTimestamp = payment.nextActionOrOnChainStateOrResultLastChangedAt;

    if (cached && cached.currentState === currentState) {
      return;
    }

    const newCache: EntityStateCache = {
      currentState,
      currentTimestamp,
      firstSeenTimestamp: cached?.firstSeenTimestamp ?? currentTimestamp,
      transitionCount: (cached?.transitionCount ?? 0) + (cached ? 1 : 0),
      network: payment.PaymentSource?.network,
      paymentSourceId: payment.PaymentSource?.id,
    };

    this.paymentStateCache.set(cacheKey, newCache);

    if (cached) {
      const duration = currentTimestamp.getTime() - cached.currentTimestamp.getTime();

      recordStateTransition('payment', cached.currentState, currentState, duration, payment.id, {
        network: newCache.network || 'unknown',
        payment_source_id: newCache.paymentSourceId || 'unknown',
      });

      logger.info('Recorded payment state transition', {
        paymentId: payment.id,
        fromState: cached.currentState,
        toState: currentState,
        duration: `${duration}ms`,
      });

      // Trigger webhook for payment state change
      try {
        await webhookEventsService.triggerPaymentOnChainStatusChanged(payment.id);
      } catch (error) {
        logger.error('Failed to trigger payment webhook', {
          paymentId: payment.id,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
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

    for (const [key, cache] of this.purchaseStateCache.entries()) {
      if (cache.currentTimestamp < cutoffTime) {
        this.purchaseStateCache.delete(key);
      }
    }

    for (const [key, cache] of this.paymentStateCache.entries()) {
      if (cache.currentTimestamp < cutoffTime) {
        this.paymentStateCache.delete(key);
      }
    }
  }

  getMonitoringStats() {
    return {
      trackedEntities: this.purchaseStateCache.size + this.paymentStateCache.size,
      purchaseCursor: this.purchaseCursor,
      paymentCursor: this.paymentCursor,
      memoryUsage: process.memoryUsage(),
    };
  }
}

export const stateTransitionMonitor = new StateTransitionMonitor();
