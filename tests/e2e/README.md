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
npm run test:e2e -- tests/e2e/flows/complete-flow-with-refund.test.ts
```

**What it tests**: Complete 11-step flow from agent registration to refund authorization

---

### Part 2: Early Refund Complete Flow  
**Filename**: `early-refund-complete-flow.test.ts`

**Command**:
```bash
npm run test:e2e -- tests/e2e/flows/early-refund-complete-flow.test.ts
```

**What it tests**: Refund requested while funds are still locked (before result submission)

---

### Part 3: Cancel Refund Request Flow
**Filename**: `cancel-refund-request-flow.test.ts`

**Command**:
```bash
npm run test:e2e -- tests/e2e/flows/cancel-refund-request-flow.test.ts
```

**What it tests**: Request refund, submit result → disputed state, then cancel the refund

---

### Part 4: Agent Deregister Flow
**Filename**: `agent-deregister-delete-flow.test.ts`

**Command**:
```bash
npm run test:e2e -- tests/e2e/flows/agent-deregister-delete-flow.test.ts
```

**What it tests**: Find existing confirmed agents and deregister them

---

### Run All Tests
```bash
npm run test:e2e
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

- Node.js and npm installed
- PostgreSQL database running
- Cardano Preprod testnet access
- Server running on `http://localhost:3001`

### 2. Environment Setup

The tests use your main `.env` file. Ensure these variables are set:

```bash
# Required
TEST_API_KEY="your-test-api-key-here"

# Database (can use temporary test database)
DATABASE_URL="postgresql://user:pass@localhost:5432/your_test_db"

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
npx prisma migrate deploy
npx prisma db seed
```

### 4. Start the Server

```bash
npm run dev
```

### 5. Run the Tests

```bash
# Run individual tests (recommended)
npm run test:e2e -- tests/e2e/flows/complete-flow-with-refund.test.ts
npm run test:e2e -- tests/e2e/flows/early-refund-complete-flow.test.ts
npm run test:e2e -- tests/e2e/flows/cancel-refund-request-flow.test.ts
npm run test:e2e -- tests/e2e/flows/agent-deregister-delete-flow.test.ts

# Or run all tests (will take longer)
npm run test:e2e
```

## 🔄 Dynamic Database Integration

### Key Features

✅ **Fully Portable**: Tests work on any developer's environment
✅ **Dynamic API Keys**: Uses environment-based authentication  
✅ **Dynamic Smart Contract Addresses**: Queries from seeded database
✅ **Dynamic Wallet VKeys**: Automatically uses seeded wallet data
✅ **No Hardcoded Dependencies**: Everything queried at runtime

### How It Works

The tests use `paymentSourceHelper.ts` utilities to:

1. **Query Active PaymentSource**: `getActiveSmartContractAddress(network)`
2. **Query Wallet VKeys**: `getTestWalletFromDatabase(network, 'seller')`
3. **Validate Environment**: Ensures database seeding is complete

This means tests work regardless of:
- Your specific API key
- Your seeded smart contract addresses  
- Your generated wallet VKeys
- Your database configuration

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

## 🔧 Technical Details

### Jest Configuration
- 24-hour timeout for blockchain operations
- Sequential execution to avoid conflicts
- Comprehensive logging and cleanup

### Blockchain Integration
- Infinite wait modes for unpredictable blockchain timing
- Proper cooldown periods between operations
- State transition validation

### Error Handling
- Network and address validation
- Authentication error detection
- Blockchain timeout management

## 🚨 Troubleshooting

### Common Issues

#### 1. "Network and Address combination not supported"
```bash
# Database not seeded properly
npx prisma db seed

# Check PaymentSource records exist
psql -d your_test_db -c "SELECT network, \"smartContractAddress\" FROM \"PaymentSource\";"
```

#### 2. "Unauthorized, invalid authentication token"  
```bash
# Check API key in database
psql -d your_test_db -c "SELECT token FROM \"ApiKey\" WHERE status = 'Active';"

# Update TEST_API_KEY to match
export TEST_API_KEY="your-actual-seeded-key"
```

#### 3. "Server is not ready"
```bash
# Ensure server is running
npm run dev

# Test server health
curl http://localhost:3001/api/v1/health
```

#### 4. "No RegistrationConfirmed agents found"
```bash
# Run tests that create agents first (Parts 1-3)
npm run test:e2e -- tests/e2e/flows/complete-flow-with-refund.test.ts

# Then run deregister test (Part 4)
npm run test:e2e -- tests/e2e/flows/agent-deregister-delete-flow.test.ts
```

### Debug Mode

Enable detailed logging:
```bash
DEBUG=* npm run test:e2e -- tests/e2e/flows/complete-flow-with-refund.test.ts
```

## 🔐 Security Notes

⚠️ **Test Environment Safety**
- Uses test database (separate from production)
- Uses Cardano Preprod network (test ADA)
- No real funds or production data involved
- API keys are for testing only

## 📈 Restore Production Environment

After testing, restore your original database:

```bash
# Update .env back to production database
DATABASE_URL="postgresql://user:pass@localhost:5432/masumi_payment_service"

# Optional: Clean up test database
dropdb masumi_payment_service_e2e_test
```

## 🤝 Contributing

When working with these tests:
1. Always use a separate test database
2. Run individual tests during development  
3. Ensure proper cleanup after testing
4. Update this README for any new test patterns

For questions or issues, refer to the main project documentation.

---

**Total Test Coverage**: 4 comprehensive E2E scenarios covering the complete Masumi Payment Service workflow