# End-to-End Test Suite

This directory contains comprehensive end-to-end tests for the Masumi Payment Service. These tests verify complete business flows from API call to blockchain confirmation.

## 🎯 What These Tests Do

The E2E tests simulate real user workflows covering the complete payment service lifecycle:

1. **Complete Payment Flow with Refund** - Full agent registration → payment → purchase → funds locked → submit result → refund process
2. **Early Refund Flow** - Refund requested before result submission
3. **Cancel Refund Request** - Cancel a refund after it's been requested
4. **Agent Deregistration** - Remove agents from the registry

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

### Part 4: Agent Deregister Flow

**Filename**: `agent-deregister-delete-flow.test.ts`

**Command**:

```bash
pnpm run test:e2e -- tests/e2e/flows/agent-deregister-delete-flow.test.ts
```

**What it tests**: Find existing confirmed agents and deregister them

---

### Run All Tests

```bash
pnpm run test:e2e
```

## 🏗️ Test Architecture

```
tests/e2e/
├── flows/                 # 4 Complete business flow tests
│   ├── complete-flow-with-refund.test.ts      # Part 1
│   ├── early-refund-complete-flow.test.ts     # Part 2
│   ├── cancel-refund-request-flow.test.ts     # Part 3
│   └── agent-deregister-delete-flow.test.ts   # Part 4
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
```

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
pnpm run test:e2e -- tests/e2e/flows/agent-deregister-delete-flow.test.ts

# Or run all tests (will take longer)
pnpm run test:e2e
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

### Part 4: Agent Deregistration

- Finds existing confirmed agents
- Calls deregister endpoint
- Verifies deregistration state
