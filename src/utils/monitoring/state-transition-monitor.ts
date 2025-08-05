import { prisma } from '@/utils/db';
import { logger } from '@/utils/logger';
import {
  recordStateTransition,
  recordBlockchainJourney,
} from '@/utils/metrics';
import {
  RegistrationState,
  PurchasingAction,
  PaymentAction,
} from '@prisma/client';

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
        this.monitorRegistrationStates(),
        this.monitorPurchaseStates(),
        this.monitorPaymentStates(),
      ]);

      this.lastCheck = new Date();
      logger.info('Completed state transition monitoring cycle');
    } catch (error) {
      logger.error('Error in state transition monitoring:', { error });
    }
  }

  private async monitorRegistrationStates() {
    try {
      const recentRegistrations = await prisma.registryRequest.findMany({
        where: {
          updatedAt: { gte: this.lastCheck },
          state: {
            in: [
              RegistrationState.RegistrationRequested,
              RegistrationState.RegistrationInitiated,
              RegistrationState.RegistrationConfirmed,
              RegistrationState.RegistrationFailed,
              RegistrationState.DeregistrationRequested,
              RegistrationState.DeregistrationInitiated,
              RegistrationState.DeregistrationConfirmed,
              RegistrationState.DeregistrationFailed,
            ],
          },
        },
        include: {
          PaymentSource: {
            select: { network: true, id: true },
          },
        },
        orderBy: { updatedAt: 'asc' },
      });

      for (const registration of recentRegistrations) {
        await this.processRegistrationStateChange(registration);
      }

      logger.info(
        `Processed ${recentRegistrations.length} registration state changes`,
      );
    } catch (error) {
      logger.error('Error monitoring registration states:', { error });
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

  private async processRegistrationStateChange(registration: {
    id: string;
    state: string;
    updatedAt: Date;
    PaymentSource?: { network?: string; id?: string };
  }) {
    const entityKey = `registration-${registration.id}`;
    const currentState: StateTransitionHistory = {
      entityType: 'registration',
      entityId: registration.id,
      state: registration.state,
      timestamp: registration.updatedAt,
      network: registration.PaymentSource?.network,
      paymentSourceId: registration.PaymentSource?.id,
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
          'registration',
          lastState.state,
          currentState.state,
          duration,
          registration.id,
          {
            network: currentState.network || 'unknown',
            payment_source_id: currentState.paymentSourceId || 'unknown',
          },
        );

        logger.info('Recorded registration state transition', {
          registrationId: registration.id,
          fromState: lastState.state,
          toState: currentState.state,
          duration: `${duration}ms`,
          network: currentState.network,
        });
      }

      if (this.isFinalRegistrationState(currentState.state)) {
        const firstState = history[0];
        if (firstState && history.length > 1) {
          const totalDuration =
            currentState.timestamp.getTime() - firstState.timestamp.getTime();

          recordBlockchainJourney(
            'registration',
            totalDuration,
            currentState.state,
            registration.id,
            {
              network: currentState.network || 'unknown',
              payment_source_id: currentState.paymentSourceId || 'unknown',
              total_transitions: history.length - 1,
            },
          );

          logger.info('Recorded complete registration journey', {
            registrationId: registration.id,
            totalDuration: `${totalDuration}ms`,
            finalState: currentState.state,
            totalTransitions: history.length - 1,
          });

          this.stateHistory.delete(entityKey);
        }
      }
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
      }
    }
  }

  private isFinalRegistrationState(state: string): boolean {
    return [
      'RegistrationConfirmed',
      'RegistrationFailed',
      'DeregistrationConfirmed',
      'DeregistrationFailed',
    ].includes(state);
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
