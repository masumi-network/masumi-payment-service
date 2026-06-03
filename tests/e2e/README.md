# End-to-End Test Suite

This directory contains comprehensive end-to-end tests for the Masumi Payment Service. These tests verify complete business flows from API call to blockchain confirmation.

## 🎯 What These Tests Do

The E2E tests simulate real user workflows covering the complete payment service lifecycle:

1. **Complete Payment Flow with Refund** - Full agent registration → payment → purchase → funds locked → submit result → refund process
2. **Early Refund Flow** - Refund requested before result submission
3. **Cancel Refund Request** - Cancel a refund after it's been requested
4. **Web3CardanoV2 Payment Source Flow** - Same public routes as V1, but with V2 source dispatch and isolated V2 wallets

## 📋 Available Tests

### Part 1: Complete Flow with Refund

**Filename**: `complete-flow-with-refund.test.ts`

**Command**:

```bash
pnpm run test:e2e -- tests/e2e/flows/complete-flow-with-refund.test.ts
```

**What it tests**: Complete 11-step flow from agent registration to refund authorization

---

### Part 2: Early Refund Complete Flow

**Filename**: `early-refund-complete-flow.test.ts`

**Command**:

```bash
pnpm run test:e2e -- tests/e2e/flows/early-refund-complete-flow.test.ts
```

**What it tests**: Refund requested while funds are still locked (before result submission)

---

### Part 3: Cancel Refund Request Flow

**Filename**: `cancel-refund-request-flow.test.ts`

**Command**:

```bash
pnpm run test:e2e -- tests/e2e/flows/cancel-refund-request-flow.test.ts
```

**What it tests**: Request refund, submit result → disputed state, then cancel the refund

---

### Part 4: Web3CardanoV2 Payment Source Flow

**Filename**: `v2/flows/v2-payment-source-flow.test.ts`

**Command**:

```bash
pnpm run test:e2e:v2
```

**What it tests**: V2 source selection, V2 wallet isolation from V1, V2 payment/purchase creation, refund authorization, and V2 cancel-refund withdrawal authorization.

---

### Run V1 Tests

```bash
pnpm run test:e2e:v1
```

`pnpm run test:e2e` is an alias for the V1 runner.

### Run V2 Tests

```bash
pnpm run test:e2e:v2
```

## 🏗️ Test Architecture

```
tests/e2e/
├── flows/                 # V1 complete business flow tests
│   ├── complete-flow-with-refund.test.ts      # Part 1
│   ├── early-refund-complete-flow.test.ts     # Part 2
│   └── cancel-refund-request-flow.test.ts     # Part 3
├── v2/
│   └── flows/
│       └── v2-payment-source-flow.test.ts     # V2 source-specific E2E flow
├── utils/                 # Reusable testing utilities
│   ├── apiClient.ts       # HTTP client wrapper
│   ├── paymentSourceHelper.ts # Dynamic database queries
│   └── waitFor.ts         # Polling utilities
├── fixtures/              # Static test data and generators
│   ├── testData.ts        # Test data generators
│   └── testWallets.ts     # Test wallet configurations (validation only)
└── setup/                 # Test environment setup
    └── testEnvironment.ts # Global test configuration
```

## 🚀 Quick Start

### 1. Prerequisites

- Node.js and pnpm installed
- PostgreSQL database running
- Cardano Preprod testnet access
- Server running on `http://localhost:3001`

### 2. Environment Setup

The tests use your main `.env` file. Ensure these variables are set:

```bash
# Required
TEST_API_KEY="your-test-api-key-here"


# Optional (defaults shown)
TEST_NETWORK="Preprod"
TEST_API_URL="http://localhost:3001"
TEST_PAYMENT_SOURCE_TYPE="Web3CardanoV1"
```

The V1 and V2 package scripts set `TEST_PAYMENT_SOURCE_TYPE` automatically. The V2 runner uses `Web3CardanoV2`, filters the active payment source by that type, and validates that V2 E2E wallets do not overlap with V1 E2E wallets when both sources are configured.

### 3. Database Setup

For clean testing, create a separate test database:

```bash
# Create test database
createdb masumi_payment_service_e2e_test

# Update .env temporarily
DATABASE_URL="postgresql://user:pass@localhost:5432/masumi_payment_service_e2e_test"

# Run migrations and seeding
pnpm exec prisma migrate deploy
pnpm exec prisma db seed
```

### 4. Start the Server

```bash
pnpm run dev
```

### 5. Run the Tests

```bash
# Run individual tests (recommended)
pnpm run test:e2e -- tests/e2e/flows/complete-flow-with-refund.test.ts
pnpm run test:e2e -- tests/e2e/flows/early-refund-complete-flow.test.ts
pnpm run test:e2e -- tests/e2e/flows/cancel-refund-request-flow.test.ts

# Run all V1 tests
pnpm run test:e2e:v1

# Run all V2 tests with the separate runner and wallet selection
pnpm run test:e2e:v2
```

## 📊 Test Scenarios

### Part 1: Complete Flow with Refund

- Agent registration and confirmation
- Payment creation with custom timing
- Purchase creation and funds locking
- Result submission and processing
- Refund request and dispute handling
- Admin authorization and completion

### Part 2: Early Refund Flow

- Same setup as Part 1
- Refund requested **before** result submission
- Result submission creates disputed state
- Admin resolves the dispute

### Part 3: Cancel Refund Request

- Same setup through disputed state
- Cancel refund request instead of authorizing
- Returns to normal completion flow

### Part 4: Web3CardanoV2 Payment Source Flow

- Uses the V2 Jest runner and `TEST_PAYMENT_SOURCE_TYPE=Web3CardanoV2`
- Selects the active V2 payment source and V2 hot wallets
- Fails if V2 wallets overlap with V1 wallets
- Verifies V2 zero-fee source setup
- Exercises V2 refund authorization and withdrawal authorization through the shared public routes
