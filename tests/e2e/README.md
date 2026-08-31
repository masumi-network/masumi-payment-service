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

## Parallel flows

Flow files run concurrently. `maxWorkers` in `jest.e2e.config.ts` defaults to 3,
one per V1 flow file. Nothing in the suite shares state across files: Jest gives
each test file its own module registry and its own `global`, and worker
processes inherit `process.env`, so the agents that `globalSetup` registered
still reach them.

Set `E2E_MAX_WORKERS=1` to run the files one after another. Do that when you are
debugging a stuck run: a worker buffers its console output until its test file
finishes, so live progress is hidden while a long on-chain wait is in flight.

Concurrent flows also make the API server slower to answer. `POST /payment` and
`POST /purchase` are CPU-heavy and share one event loop with the schedulers, so
three at once stretch a ~5s call past 20s. Raise `TEST_TIMEOUT_API` (CI uses
`120000`) instead of accepting the 30s default, or requests abort mid-flow.

### One selling wallet per flow (optional)

What still serializes is on chain. V1 takes one request per hot wallet per
scheduler tick and keeps the wallet locked until the transaction confirms, so
concurrent flows that share a wallet pipeline instead of overlapping.

`globalSetup` registers `E2E_AGENTS_PER_SOURCE` agents per payment source, each
bound to its own selling hot wallet, and each flow file claims an agent slot
(`AGENT_SLOT` in the file, resolved by `pickAgentForSlot`). The default is 1:
one agent shared by every flow, which is how the flows behaved when they ran one
at a time.

To give the three V1 flows a wallet each, seed two more selling wallets and
raise the count:

```bash
# seed step
SELLING_WALLET_PREPROD_MNEMONIC_2="24 words ..."
SELLING_WALLET_PREPROD_MNEMONIC_3="24 words ..."

# test step
E2E_AGENTS_PER_SOURCE=3
```

The seed reads `SELLING_WALLET_PREPROD_MNEMONIC_2`, `_3` and so on, stopping at
the first gap, and never brews a replacement. Every extra mnemonic must be a
distinct and **funded** Preprod wallet: an unfunded wallet is still picked by the
scheduler and stalls the flow that owns it. Asking for more agents than there
are wallets logs a warning and falls back to sharing.

The wallets are created while the payment source is seeded. A database that
already holds the V1 source skips seeding under `SEED_ONLY_IF_EMPTY=true`, so a
mnemonic added later needs a fresh database. CI creates one per run.

Buyer-side actions (request-refund, cancel-refund) still queue. They run on the
purchasing wallet, and the V1 batch builder fills the first eligible purchasing
wallet before it uses a second one, so extra purchasing wallets do not spread
them. Pinning a purchase to a wallet needs a wallet-scoped API key per flow.

### Purchasing wallet funding

Concurrent flows lock funds together, in one batched transaction from one
purchasing wallet, so that wallet needs `maxWorkers` locks' worth at once rather
than one lock at a time. `globalSetup` checks this before any on-chain work and
fails with the required amount and the observed balances. The check exists
because the batch builder parks requests it cannot fund in
`WaitingForManualAction` with `InsufficientFunds`, and that state never retries.

The floor scales with `maxWorkers`, so a single-file debugging run still asks for
the full amount. Set `E2E_MAX_WORKERS=1` to lower it.

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
