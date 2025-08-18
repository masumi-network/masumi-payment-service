import { WebhookEventType } from '@prisma/client';

// Base webhook payload structure
export interface BaseWebhookPayload {
  event_type: WebhookEventType;
  timestamp: string;
  webhook_id: string;
  data: Record<string, unknown>;
}

// Purchase status change event
export interface PurchaseStatusChangedPayload extends BaseWebhookPayload {
  event_type: 'PURCHASE_STATUS_CHANGED';
  data: {
    purchase_id: string;
    blockchain_identifier: string;
    old_status: string;
    new_status: string;
    agent_id?: string;
    payment_id?: string;
    transaction_hash?: string;
    updated_at: string;
  };
}

// Payment status change event
export interface PaymentStatusChangedPayload extends BaseWebhookPayload {
  event_type: 'PAYMENT_STATUS_CHANGED';
  data: {
    payment_id: string;
    purchase_id: string;
    old_status: string;
    new_status: string;
    transaction_hash?: string;
    amount?: string;
    currency?: string;
    blockchain_network: string;
    updated_at: string;
  };
}

// Agent registration change event
export interface AgentRegistrationChangedPayload extends BaseWebhookPayload {
  event_type: 'AGENT_REGISTRATION_CHANGED';
  data: {
    agent_id: string;
    blockchain_identifier: string;
    old_status: string;
    new_status: string;
    agent_name?: string;
    registration_transaction_hash?: string;
    updated_at: string;
  };
}

// Transaction confirmed event
export interface TransactionConfirmedPayload extends BaseWebhookPayload {
  event_type: 'TRANSACTION_CONFIRMED';
  data: {
    transaction_hash: string;
    blockchain_network: string;
    block_number: number;
    confirmation_count: number;
    purchase_id?: string;
    payment_id?: string;
    agent_id?: string;
    confirmed_at: string;
  };
}

// Transaction failed event
export interface TransactionFailedPayload extends BaseWebhookPayload {
  event_type: 'TRANSACTION_FAILED';
  data: {
    transaction_hash?: string;
    blockchain_network: string;
    purchase_id?: string;
    payment_id?: string;
    agent_id?: string;
    error_message: string;
    error_code?: string;
    failed_at: string;
  };
}

// Timeout reached event
export interface TimeoutReachedPayload extends BaseWebhookPayload {
  event_type: 'TIMEOUT_REACHED';
  data: {
    entity_type: 'purchase' | 'payment' | 'agent_registration';
    entity_id: string;
    timeout_type:
      | 'payment_timeout'
      | 'processing_timeout'
      | 'confirmation_timeout';
    timeout_duration_seconds: number;
    original_status: string;
    new_status: string;
    timed_out_at: string;
  };
}

// Union type for all webhook payloads
export type WebhookPayload =
  | PurchaseStatusChangedPayload
  | PaymentStatusChangedPayload
  | AgentRegistrationChangedPayload
  | TransactionConfirmedPayload
  | TransactionFailedPayload
  | TimeoutReachedPayload;

// Event type values for runtime use
export const WEBHOOK_EVENT_VALUES = {
  PURCHASE_STATUS_CHANGED: 'PURCHASE_STATUS_CHANGED' as const,
  PAYMENT_STATUS_CHANGED: 'PAYMENT_STATUS_CHANGED' as const,
  AGENT_REGISTRATION_CHANGED: 'AGENT_REGISTRATION_CHANGED' as const,
  TRANSACTION_CONFIRMED: 'TRANSACTION_CONFIRMED' as const,
  TRANSACTION_FAILED: 'TRANSACTION_FAILED' as const,
  TIMEOUT_REACHED: 'TIMEOUT_REACHED' as const,
} as const;
