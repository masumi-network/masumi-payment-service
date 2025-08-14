import { webhookQueueService } from './webhook-queue.service';
import { logger } from '@/utils/logger';

export class WebhookEventsService {
  //purchase status change webhook
  async triggerPurchaseStatusChange(data: {
    blockchainIdentifier: string;
    purchaseId: string;
    oldStatus?: string;
    newStatus: string;
    onChainState?: string;
    nextAction?: string;
    errorType?: string;
    errorNote?: string;
    paymentSourceId?: string;
  }): Promise<void> {
    try {
      await webhookQueueService.queueWebhook(
        'purchase.status_changed',
        {
          blockchainIdentifier: data.blockchainIdentifier,
          purchase_id: data.purchaseId,
          old_status: data.oldStatus,
          new_status: data.newStatus,
          on_chain_state: data.onChainState,
          next_action: data.nextAction,
          error_type: data.errorType,
          error_note: data.errorNote,
          timestamp: new Date().toISOString(),
        },
        data.blockchainIdentifier,
        data.paymentSourceId,
      );

      logger.info('Purchase status change webhook triggered', {
        blockchain_identifier: data.blockchainIdentifier,
        old_status: data.oldStatus,
        new_status: data.newStatus,
      });
    } catch (error) {
      logger.error('Failed to trigger purchase status change webhook', {
        blockchain_identifier: data.blockchainIdentifier,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  // payment status change webhook
  async triggerPaymentStatusChange(data: {
    blockchainIdentifier: string;
    paymentId: string;
    oldStatus?: string;
    newStatus: string;
    onChainState?: string;
    nextAction?: string;
    errorType?: string;
    errorNote?: string;
    paymentSourceId?: string;
  }): Promise<void> {
    try {
      await webhookQueueService.queueWebhook(
        'payment.status_changed',
        {
          blockchainIdentifier: data.blockchainIdentifier,
          payment_id: data.paymentId,
          old_status: data.oldStatus,
          new_status: data.newStatus,
          on_chain_state: data.onChainState,
          next_action: data.nextAction,
          error_type: data.errorType,
          error_note: data.errorNote,
          timestamp: new Date().toISOString(),
        },
        data.blockchainIdentifier,
        data.paymentSourceId,
      );

      logger.info('Payment status change webhook triggered', {
        blockchain_identifier: data.blockchainIdentifier,
        old_status: data.oldStatus,
        new_status: data.newStatus,
      });
    } catch (error) {
      logger.error('Failed to trigger payment status change webhook', {
        blockchain_identifier: data.blockchainIdentifier,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  //agent registration change webhook
  async triggerAgentRegistrationChange(data: {
    agentId: string;
    agentIdentifier?: string;
    oldState?: string;
    newState: string;
    errorMessage?: string;
    paymentSourceId?: string;
  }): Promise<void> {
    try {
      await webhookQueueService.queueWebhook(
        'agent.registration_changed',
        {
          agent_id: data.agentId,
          agent_identifier: data.agentIdentifier,
          old_state: data.oldState,
          new_state: data.newState,
          error_message: data.errorMessage,
          timestamp: new Date().toISOString(),
        },
        data.agentId,
        data.paymentSourceId,
      );

      logger.info('Agent registration change webhook triggered', {
        agent_id: data.agentId,
        old_state: data.oldState,
        new_state: data.newState,
      });
    } catch (error) {
      logger.error('Failed to trigger agent registration change webhook', {
        agent_id: data.agentId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  //transaction confirmation webhook
  async triggerTransactionConfirmed(data: {
    transactionId: string;
    txHash: string;
    entityType: 'payment' | 'purchase' | 'agent';
    entityId: string;
    blockchainIdentifier?: string;
    paymentSourceId?: string;
  }): Promise<void> {
    try {
      await webhookQueueService.queueWebhook(
        'transaction.confirmed',
        {
          transaction_id: data.transactionId,
          tx_hash: data.txHash,
          entity_type: data.entityType,
          entity_id: data.entityId,
          blockchain_identifier: data.blockchainIdentifier,
          timestamp: new Date().toISOString(),
        },
        data.blockchainIdentifier || data.entityId,
        data.paymentSourceId,
      );

      logger.info('Transaction confirmed webhook triggered', {
        tx_hash: data.txHash,
        entity_type: data.entityType,
        entity_id: data.entityId,
      });
    } catch (error) {
      logger.error('Failed to trigger transaction confirmed webhook', {
        tx_hash: data.txHash,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  //transaction failed webhook
  async triggerTransactionFailed(data: {
    transactionId: string;
    txHash?: string;
    entityType: 'payment' | 'purchase' | 'agent';
    entityId: string;
    blockchainIdentifier?: string;
    errorMessage?: string;
    paymentSourceId?: string;
  }): Promise<void> {
    try {
      await webhookQueueService.queueWebhook(
        'transaction.failed',
        {
          transaction_id: data.transactionId,
          tx_hash: data.txHash,
          entity_type: data.entityType,
          entity_id: data.entityId,
          blockchain_identifier: data.blockchainIdentifier,
          error_message: data.errorMessage,
          timestamp: new Date().toISOString(),
        },
        data.blockchainIdentifier || data.entityId,
        data.paymentSourceId,
      );

      logger.info('Transaction failed webhook triggered', {
        tx_hash: data.txHash,
        entity_type: data.entityType,
        entity_id: data.entityId,
        error: data.errorMessage,
      });
    } catch (error) {
      logger.error('Failed to trigger transaction failed webhook', {
        tx_hash: data.txHash,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
}

export const webhookEventsService = new WebhookEventsService();
