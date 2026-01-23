# Webhook Event Types and Payload Documentation

This document defines the type-safe webhook events and their payload structures for the Masumi Payment Service webhook system.

## Overview

The webhook system uses strongly-typed enums and predefined payload structures to ensure consistency and type safety. All webhook payloads follow a common structure with specific data fields for each event type.

**Important**: The webhook payload data structure exactly matches the GET endpoints for purchases and payments, ensuring consistency across the API.

## Getting Started

Webhooks notify external services when payments or purchases change status. Instead of polling the API, external services receive instant HTTP notifications.

**Quick Overview**:

1. External service registers webhook URL
2. Payment/purchase status changes in Masumi
3. System queues webhook delivery
4. Background job sends HTTP POST to registered URL (every 10 seconds)
5. Retry automatically if delivery fails

## How to Implement Webhooks

### Add Trigger Code

Import the webhook service:

```typescript
import { webhookEventsService } from '../webhook-handler/webhook-events.service';
```

Add trigger after status changes:

```typescript
// After payment completes
await webhookEventsService.triggerPaymentOnChainStatusChanged(paymentId);

// After purchase completes
await webhookEventsService.triggerPurchaseOnChainStatusChanged(purchaseId);

// On error
await webhookEventsService.triggerPaymentOnError(paymentId);
await webhookEventsService.triggerPurchaseOnError(purchaseId);
```

### Handle Errors Gracefully

Always wrap in try-catch:

```typescript
try {
  await webhookEventsService.triggerPaymentOnChainStatusChanged(paymentId);
} catch (error) {
  logger.error('Webhook trigger failed', { error, paymentId });
  // Don't throw - webhook failures shouldn't break main flow
}
```

### Best Practices

- Trigger webhooks AFTER database updates complete
- Never throw errors from webhook triggers
- Log all webhook triggers for debugging
- Use specific event types for each scenario

## Testing Webhooks Locally

### Quick Test with webhook.site

1. Go to https://webhook.site
2. Copy your unique URL (e.g., `https://webhook.site/abc-123`)
3. Register webhook via API:

```bash
curl -X POST http://localhost:3000/api/v1/webhooks \
  -H "token: your_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://webhook.site/abc-123",
    "authToken": "test-token",
    "events": ["PAYMENT_ON_CHAIN_STATUS_CHANGED"]
  }'
```

4. Trigger a payment event in your code
5. See the webhook appear on webhook.site instantly

### Check Database

View pending deliveries:

```sql
SELECT * FROM "WebhookDelivery" WHERE status = 'Pending';
```

View failed deliveries:

```sql
SELECT * FROM "WebhookDelivery" WHERE status = 'Failed' ORDER BY "createdAt" DESC LIMIT 10;
```

View all registered webhooks:

```sql
SELECT id, url, "isActive", events FROM "WebhookEndpoint";
```

## Troubleshooting

### Webhooks Not Being Sent?

1. **Check if webhook is active:**

```sql
SELECT url, "isActive", events FROM "WebhookEndpoint";
```

2. **Check if deliveries are created:**

```sql
SELECT * FROM "WebhookDelivery" ORDER BY "createdAt" DESC LIMIT 5;
```

3. **Check logs:**

```bash
docker logs <container> | grep -i webhook
```

### Webhook Auto-Disabled?

After 10 consecutive failures, webhooks auto-disable.

**Re-enable:**

```sql
UPDATE "WebhookEndpoint"
SET "isActive" = true, "consecutiveFailures" = 0, "disabledAt" = NULL
WHERE id = 'your-webhook-id';
```

### Deliveries Stuck in Pending?

Check if background job is running:

```bash
docker logs <container> | grep "webhook delivery processor"
```

Should appear every 10 seconds.

## Complete Example

```typescript
import { webhookEventsService } from '../webhook-handler/webhook-events.service';
import { logger } from '@/utils/logger';

async function processPayment(paymentId: string) {
  try {
    // 1. Process payment
    await updatePaymentStatus(paymentId, 'Completed');

    // 2. Trigger webhook (non-blocking)
    try {
      logger.info('Triggering payment webhook', { paymentId });
      await webhookEventsService.triggerPaymentOnChainStatusChanged(paymentId);
    } catch (webhookError) {
      logger.error('Webhook trigger failed', { webhookError });
      // Continue - don't let webhook failures break main flow
    }
  } catch (error) {
    // On main error, trigger error webhook
    logger.error('Payment processing failed', { error });

    try {
      await webhookEventsService.triggerPaymentOnError(paymentId);
    } catch (webhookError) {
      logger.error('Error webhook trigger failed', { webhookError });
    }

    throw error;
  }
}
```

## Event Types

All webhook events use the `WebhookEventType` enum:

```typescript
enum WebhookEventType {
  PURCHASE_ON_CHAIN_STATUS_CHANGED
  PAYMENT_ON_CHAIN_STATUS_CHANGED
  PURCHASE_ON_ERROR
  PAYMENT_ON_ERROR
}
```

## Common Payload Structure

All webhook payloads follow this base structure:

```typescript
interface BaseWebhookPayload {
  event_type: WebhookEventType;
  timestamp: string;
  webhook_id: string;
  data: Record<string, unknown>;
}
```

## Event-Specific Payloads

### 1. PURCHASE_ON_CHAIN_STATUS_CHANGED

Triggered when a purchase's on-chain status changes (e.g., funds locked, etc.).

```typescript
interface PurchaseOnChainStatusChangedPayload {
  event_type: 'PURCHASE_ON_CHAIN_STATUS_CHANGED';
  timestamp: string;
  webhook_id: string;
  data: {
    id: string;
    blockchainIdentifier: string;
    onChainState: string;
    submitResultTime: string;
    unlockTime: string;
    externalDisputeUnlockTime: string;
    cooldownTime: number;
    cooldownTimeOtherParty: number;
    PaymentSource: {
      id: string;
      network: string;
      smartContractAddress: string;
      policyId: string;
      paymentType: string;
      feeRatePermille: number;
      cooldownTime: number;
    };
    SellerWallet: {
      id: string;
      walletAddress: string;
      walletVkey: string;
      type: string;
    };
    NextAction: {
      id: string;
      requestedAction: string;
      inputHash: string;
      submittedTxHash: string | null;
      errorType: string | null;
      errorNote: string | null;
    };
    PaidFunds: Array<{ unit: string; amount: string }>;
    TransactionHistory: Array<object>;
    WithdrawnForBuyer: Array<{ unit: string; amount: string }>;
    WithdrawnForSeller: Array<{ unit: string; amount: string }>;
  };
}
```

**Example:**

```json
{
  "event_type": "PURCHASE_ON_CHAIN_STATUS_CHANGED",
  "timestamp": "2025-08-20T05:07:11.157Z",
  "webhook_id": "cmejigo89000gucbqgmqphura",
  "data": {
    "id": "cmejigo85000cucbqnscuc2l6",
    "blockchainIdentifier": "purchase-blockchain-1755666431140",
    "onChainState": "FundsLocked",
    "submitResultTime": "1755669953855",
    "unlockTime": "1755673553855",
    "externalDisputeUnlockTime": "1755677153855",
    "cooldownTime": 7200,
    "cooldownTimeOtherParty": 3600,
    "PaymentSource": {
      "id": "cmejif0l60004uc3rea61s1mz",
      "network": "Preprod",
      "smartContractAddress": "addr_test_1755666353849",
      "paymentType": "Web3CardanoV1",
      "feeRatePermille": 25
    },
    "SellerWallet": {
      "id": "cmejif0l80006uc3r1q2r5d56",
      "walletAddress": "addr_test_seller",
      "type": "Seller"
    },
    "NextAction": {
      "requestedAction": "FundsLockingRequested",
      "inputHash": "test-input-hash"
    },
    "PaidFunds": [],
    "TransactionHistory": []
  }
}
```

### 2. PAYMENT_ON_CHAIN_STATUS_CHANGED

Triggered when a payment's on-chain status changes (e.g., funds locked, payment confirmed, etc.).

```typescript
interface PaymentOnChainStatusChangedPayload {
  event_type: 'PAYMENT_ON_CHAIN_STATUS_CHANGED';
  timestamp: string;
  webhook_id: string;
  data: {
    id: string;
    blockchainIdentifier: string;
    onChainState: string;
    submitResultTime: string;
    unlockTime: string;
    externalDisputeUnlockTime: string;
    cooldownTime: number;
    cooldownTimeOtherParty: number;
    PaymentSource: {
      id: string;
      network: string;
      smartContractAddress: string;
      policyId: string;
      paymentType: string;
      feeRatePermille: number;
      cooldownTime: number;
    };
    BuyerWallet: {
      id: string;
      walletAddress: string;
      walletVkey: string;
      type: string;
    };
    NextAction: {
      id: string;
      requestedAction: string;
      inputHash: string;
      submittedTxHash: string | null;
      errorType: string | null;
      errorNote: string | null;
    };
    RequestedFunds: Array<{ unit: string; amount: string }>;
    TransactionHistory: Array<object>;
    WithdrawnForBuyer: Array<{ unit: string; amount: string }>;
    WithdrawnForSeller: Array<{ unit: string; amount: string }>;
  };
}
```

**Example:**

```json
{
  "event_type": "PAYMENT_ON_CHAIN_STATUS_CHANGED",
  "timestamp": "2025-08-20T05:07:11.383Z",
  "webhook_id": "cmejigo89000gucbqgmqphura",
  "data": {
    "id": "cmejigo87000eucbqxtt7cnct",
    "blockchainIdentifier": "payment-blockchain-1755666431143",
    "onChainState": "FundsLocked",
    "submitResultTime": "1755669953858",
    "unlockTime": "1755673553858",
    "externalDisputeUnlockTime": "1755677153858",
    "cooldownTime": 7200,
    "cooldownTimeOtherParty": 3600,
    "PaymentSource": {
      "id": "cmejif0l60004uc3rea61s1mz",
      "network": "Preprod",
      "smartContractAddress": "addr_test_1755666353849",
      "paymentType": "Web3CardanoV1",
      "feeRatePermille": 25
    },
    "BuyerWallet": {
      "id": "cmejif0la000auc3r8k2m1pqx",
      "walletAddress": "addr_test_buyer",
      "type": "Buyer"
    },
    "NextAction": {
      "requestedAction": "FundsLockingRequested",
      "inputHash": "test-input-hash"
    },
    "RequestedFunds": [],
    "TransactionHistory": []
  }
}
```

### 3. PURCHASE_ON_ERROR

Triggered when a purchase encounters an error (e.g., transaction failure, validation error, timeout).

```typescript
interface PurchaseOnErrorPayload {
  event_type: 'PURCHASE_ON_ERROR';
  timestamp: string;
  webhook_id: string;
  data: {
    id: string;
    blockchainIdentifier: string;
    onChainState: string;
  };
}
```

**Example:**

```json
{
  "event_type": "PURCHASE_ON_ERROR",
  "timestamp": "2025-08-20T05:07:11.270Z",
  "webhook_id": "cmejigo89000gucbqgmqphura",
  "data": {
    "id": "cmejigo85000cucbqnscuc2l6",
    "blockchainIdentifier": "purchase-blockchain-1755666431140",
    "onChainState": "FundsLocked",
    "NextAction": {
      "requestedAction": "FundsLockingRequested",
      "errorType": "TRANSACTION_FAILED",
      "errorNote": "Insufficient funds for transaction fee"
    }
  }
}
```

### 4. PAYMENT_ON_ERROR

Triggered when a payment encounters an error (e.g., transaction failure, validation error, timeout).

```typescript
interface PaymentOnErrorPayload {
  event_type: 'PAYMENT_ON_ERROR';
  timestamp: string;
  webhook_id: string;
  data: {
    id: string;
    blockchainIdentifier: string;
    onChainState: string;
  };
}
```

**Example:**

```json
{
  "event_type": "PAYMENT_ON_ERROR",
  "timestamp": "2025-08-20T05:07:11.497Z",
  "webhook_id": "cmejigo89000gucbqgmqphura",
  "data": {
    "id": "cmejigo87000eucbqxtt7cnct",
    "blockchainIdentifier": "payment-blockchain-1755666431143",
    "onChainState": "FundsLocked",
    "NextAction": {
      "requestedAction": "PaymentConfirmationRequested",
      "errorType": "NETWORK_ERROR",
      "errorNote": "Unable to connect to blockchain node"
    }
  }
}
```

## Webhook Registration

To register for webhook events, use the pay-authenticated endpoint (requires ReadAndPay permission):

```bash
curl -X POST https://masumi-api.com/api/v1/webhooks \
  -H "Content-Type: application/json" \
  -H "token: <pay_api_key>" \
  -d '{
    "name": "My Service Webhook",
    "url": "https://myservice.com/webhooks/masumi",
    "authToken": "my-secret-token",
    "events": [
      "PURCHASE_ON_CHAIN_STATUS_CHANGED",
      "PAYMENT_ON_CHAIN_STATUS_CHANGED",
      "PURCHASE_ON_ERROR",
      "PAYMENT_ON_ERROR"
    ],
    "paymentSourceId": "optional-payment-source-id"
  }'
```

## Webhook Management

### Delete a Webhook

Only the creator of the webhook or an admin can delete it:

```bash
curl -X DELETE https://masumi-api.com/api/v1/webhooks \
  -H "Content-Type: application/json" \
  -H "token: <pay_api_key>" \
  -d '{
    "webhookId": "webhook-id-to-delete"
  }'
```

### List Webhooks

View all webhooks (admin only):

```bash
curl -X GET "https://masumi-api.com/api/v1/webhooks?limit=20" \
  -H "token: <admin_api_key>"
```

## Error Handling

Your webhook endpoint should:

1. **Return HTTP 200** for successful processing
2. **Return HTTP 4xx/5xx** for errors (triggers retry)
3. **Respond within 10 seconds** (timeout limit)
4. **Validate the auth token** in the Authorization header

## Retry Policy

Failed webhook deliveries are retried with exponential backoff:

- **Retry 1**: 30 seconds
- **Retry 2**: 60 seconds
- **Retry 3**: 120 seconds
- **Retry 4**: 240 seconds
- **Retry 5**: 480 seconds

After 10 consecutive failures, the webhook endpoint is automatically disabled.
