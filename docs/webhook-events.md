# Webhook Event Types and Payload Documentation

This document defines the type-safe webhook events and their payload structures for the Masumi Payment Service webhook system.

## Overview

The webhook system uses strongly-typed enums and predefined payload structures to ensure consistency and type safety. All webhook payloads follow a common structure with specific data fields for each event type.

## Event Types

All webhook events use the `WebhookEventType` enum:

```typescript
enum WebhookEventType {
  PURCHASE_STATUS_CHANGED
  PAYMENT_STATUS_CHANGED
  AGENT_REGISTRATION_CHANGED
  TRANSACTION_CONFIRMED
  TRANSACTION_FAILED
  TIMEOUT_REACHED
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

### 1. PURCHASE_STATUS_CHANGED

Triggered when a purchase changes status (e.g., pending → processing → completed).

```typescript
interface PurchaseStatusChangedPayload {
  event_type: "PURCHASE_STATUS_CHANGED";
  timestamp: string;
  webhook_id: string;
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
```

**Example:**
```json
{
  "event_type": "PURCHASE_STATUS_CHANGED",
  "timestamp": "2025-01-13T10:30:00.000Z",
  "webhook_id": "webhook_123",
  "data": {
    "purchase_id": "purchase_456",
    "blockchain_identifier": "0x1234567890abcdef",
    "old_status": "pending",
    "new_status": "processing",
    "agent_id": "agent_789",
    "payment_id": "payment_101",
    "updated_at": "2025-01-13T10:30:00.000Z"
  }
}
```

### 2. PAYMENT_STATUS_CHANGED

Triggered when payment status changes (e.g., initiated → confirmed → settled).

```typescript
interface PaymentStatusChangedPayload {
  event_type: "PAYMENT_STATUS_CHANGED";
  timestamp: string;
  webhook_id: string;
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
```

**Example:**
```json
{
  "event_type": "PAYMENT_STATUS_CHANGED",
  "timestamp": "2025-01-13T10:35:00.000Z",
  "webhook_id": "webhook_123",
  "data": {
    "payment_id": "payment_101",
    "purchase_id": "purchase_456",
    "old_status": "pending",
    "new_status": "confirmed",
    "transaction_hash": "0xabcdef1234567890",
    "amount": "100.50",
    "currency": "ADA",
    "blockchain_network": "mainnet",
    "updated_at": "2025-01-13T10:35:00.000Z"
  }
}
```

### 3. AGENT_REGISTRATION_CHANGED

Triggered when agent registration status changes.

```typescript
interface AgentRegistrationChangedPayload {
  event_type: "AGENT_REGISTRATION_CHANGED";
  timestamp: string;
  webhook_id: string;
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
```

**Example:**
```json
{
  "event_type": "AGENT_REGISTRATION_CHANGED",
  "timestamp": "2025-01-13T11:00:00.000Z",
  "webhook_id": "webhook_123",
  "data": {
    "agent_id": "agent_789",
    "blockchain_identifier": "agent.masumi.network",
    "old_status": "pending",
    "new_status": "registered",
    "agent_name": "Data Analysis Agent",
    "registration_transaction_hash": "0xfedcba0987654321",
    "updated_at": "2025-01-13T11:00:00.000Z"
  }
}
```

### 4. TRANSACTION_CONFIRMED

Triggered when blockchain transactions receive sufficient confirmations.

```typescript
interface TransactionConfirmedPayload {
  event_type: "TRANSACTION_CONFIRMED";
  timestamp: string;
  webhook_id: string;
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
```

**Example:**
```json
{
  "event_type": "TRANSACTION_CONFIRMED",
  "timestamp": "2025-01-13T11:15:00.000Z",
  "webhook_id": "webhook_123",
  "data": {
    "transaction_hash": "0xabcdef1234567890",
    "blockchain_network": "mainnet",
    "block_number": 8765432,
    "confirmation_count": 6,
    "purchase_id": "purchase_456",
    "payment_id": "payment_101",
    "confirmed_at": "2025-01-13T11:15:00.000Z"
  }
}
```

### 5. TRANSACTION_FAILED

Triggered when blockchain transactions fail.

```typescript
interface TransactionFailedPayload {
  event_type: "TRANSACTION_FAILED";
  timestamp: string;
  webhook_id: string;
  data: {
    transaction_hash?: string;    Network where failure occurred
    purchase_id?: string;       
    payment_id?: string;        
    agent_id?: string;        
    error_message: string;    
    error_code?: string;     
    failed_at: string;        
  };
}
```

**Example:**
```json
{
  "event_type": "TRANSACTION_FAILED",
  "timestamp": "2025-01-13T11:30:00.000Z",
  "webhook_id": "webhook_123",
  "data": {
    "transaction_hash": "0x1111222233334444",
    "blockchain_network": "mainnet",
    "purchase_id": "purchase_789",
    "payment_id": "payment_202",
    "error_message": "Insufficient funds for transaction",
    "error_code": "INSUFFICIENT_FUNDS",
    "failed_at": "2025-01-13T11:30:00.000Z"
  }
}
```

### 6. TIMEOUT_REACHED

Triggered when operations exceed their time limits.

```typescript
interface TimeoutReachedPayload {
  event_type: "TIMEOUT_REACHED";
  timestamp: string;
  webhook_id: string;
  data: {
    entity_type: "purchase" | "payment" | "agent_registration";
    entity_id: string;                  
    timeout_type: "payment_timeout" | "processing_timeout" | "confirmation_timeout";
    timeout_duration_seconds: number;   
    original_status: string;          
    new_status: string;                 
    timed_out_at: string;           
  };
}
```

**Example:**
```json
{
  "event_type": "TIMEOUT_REACHED",
  "timestamp": "2025-01-13T12:00:00.000Z",
  "webhook_id": "webhook_123",
  "data": {
    "entity_type": "payment",
    "entity_id": "payment_303",
    "timeout_type": "payment_timeout",
    "timeout_duration_seconds": 1800,
    "original_status": "pending",
    "new_status": "timed_out",
    "timed_out_at": "2025-01-13T12:00:00.000Z"
  }
}
```

## HTTP Headers

All webhook requests include these headers:

```http
Content-Type: application/json
Authorization: Bearer <webhook_auth_token>
X-Masumi-Event: <event_type>
User-Agent: Masumi-Webhook/1.0
```

## Webhook Registration

To register for webhook events, use the admin-authenticated endpoint:

```bash
curl -X POST https://masumi-api.com/api/v1/webhooks \
  -H "Content-Type: application/json" \
  -H "token: <admin_api_key>" \
  -d '{
    "name": "My Service Webhook",
    "url": "https://myservice.com/webhooks/masumi",
    "authToken": "my-secret-token",
    "events": [
      "PURCHASE_STATUS_CHANGED",
      "PAYMENT_STATUS_CHANGED"
    ]
  }'
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

