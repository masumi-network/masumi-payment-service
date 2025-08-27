# End-to-End Test Suite

This directory contains comprehensive end-to-end tests for the Masumi Payment Service. These tests verify complete business flows from API call to blockchain confirmation.

## 🎯 What These Tests Do

The e2e tests simulate real user workflows:

1. **Agent Registration Flow**
   - Submit agent registration
   - Wait for blockchain processing  
   - Verify registration confirmation
   - Check agent appears in registry

2. **Future Flows** (to be implemented)
   - Payment creation and execution
   - Purchase flows with refunds
   - Complete agent-to-agent transactions

## 🏗️ Test Architecture

```
tests/e2e/
├── flows/                 # Complete business flow tests
│   └── registration.test.ts
├── utils/                 # Reusable testing utilities
│   ├── apiClient.ts       # HTTP client wrapper  
│   ├── waitFor.ts         # Polling utilities
│   └── testData.ts        # Test data generators
├── fixtures/              # Static test data
│   └── testWallets.ts     # Test wallet configurations
└── setup/                 # Test environment setup
    └── testEnvironment.ts # Global test configuration
```

## 🚀 Quick Start

### 1. Prerequisites

- Node.js and npm installed
- PostgreSQL database running
- Cardano test wallets with ADA
- API keys for your test environment

### 2. Environment Setup

Create a `.env.test` file or export these variables:

```bash
# Required
export TEST_API_KEY="your-test-api-key-here"

# Optional (defaults shown)
export TEST_NETWORK="Preprod"
export TEST_API_URL="http://localhost:3001"
export TEST_DATABASE_URL="postgresql://test@localhost:5432/masumi_payment_service_test"

# Timeouts (in milliseconds)
export TEST_API_TIMEOUT="30000"
export TEST_REGISTRATION_TIMEOUT="300000"
export TEST_BLOCKCHAIN_TIMEOUT="600000"
```

### 3. Configure Test Wallets

⚠️ **IMPORTANT**: Update test wallet configurations in `fixtures/testWallets.ts`

Replace placeholder vkeys with actual test wallets:
- Seller wallets (for agent registration)
- Buyer wallets (for purchases)  
- Admin wallets (for admin operations)

### 4. Start the Server

In one terminal:
```bash
npm run dev
```

### 5. Run the Tests

In another terminal:
```bash
# Run all e2e tests
npm run test:e2e

# Run just registration tests
npm run test:e2e:registration

# Run with detailed output
npm run test:e2e:verbose

# Run in watch mode (for development)
npm run test:e2e:watch
```

## 📋 Test Configuration

### Jest Configuration

The tests use a separate Jest config (`jest.e2e.config.ts`) with:
- 10-minute test timeout (blockchain operations are slow)
- Sequential execution (avoid conflicts)
- Separate test environment setup

### API Client

Tests use a custom `ApiClient` wrapper instead of curl:
- Automatic authentication headers
- Error handling and retries
- Request/response logging
- TypeScript types for all endpoints

### waitFor Utilities

Specialized polling functions for async operations:
- `waitForRegistrationState()` - Wait for registration confirmation
- `waitForAgentIdentifier()` - Wait for agent ID creation
- `waitForServer()` - Wait for server startup
- Generic `waitFor()` - Custom polling conditions

## 🧪 Test Scenarios

### Registration Tests

#### ✅ Happy Path Tests
- **Basic Agent**: Simple registration with minimal config
- **Premium Agent**: Multi-tier pricing and complex metadata
- **Multi-Output Agent**: Agents with multiple example outputs

#### ❌ Error Handling Tests  
- Invalid wallet verification keys
- Missing required fields
- Malformed data structures
- Network/timeout scenarios

#### ⏱️ Timing Tests
- waitFor timeout handling
- Registration processing delays
- Server startup timing

## 🔧 Customization

### Adding New Flow Tests

1. Create test file in `flows/` directory
2. Import required utilities
3. Use `global.testApiClient` for API calls
4. Add cleanup for test data

Example:
```typescript
// tests/e2e/flows/payment.test.ts
import { generateTestPaymentData } from '../utils/testData';
import { waitForPaymentConfirmation } from '../utils/waitFor';

describe('Payment Flow E2E', () => {
  test('should create and execute payment', async () => {
    const paymentData = generateTestPaymentData();
    const response = await global.testApiClient.createPayment(paymentData);
    
    await waitForPaymentConfirmation(response.id);
    // ... assertions
  });
});
```

### Adding New Utilities

Create reusable functions in `utils/`:
- `testData.ts` - Data generators
- `waitFor.ts` - Polling utilities  
- `assertions.ts` - Custom expect matchers

### Environment Variables

All configuration through environment variables:
- `TEST_*` prefix for test-specific config
- Sensible defaults for development
- Override for different environments

## 🚨 Troubleshooting

### Common Issues

#### 1. "Server is not ready" 
```bash
# Make sure server is running
npm run dev

# Check server URL
curl http://localhost:3000/api/v1/health
```

#### 2. "API key validation failed"
```bash
# Verify API key is correct
export TEST_API_KEY="your-actual-api-key"

# Test manually
curl -H "Authorization: Bearer $TEST_API_KEY" http://localhost:3000/api/v1/health
```

#### 3. "Test wallet validation failed"
- Update `fixtures/testWallets.ts` with real test wallet vkeys
- Ensure wallets exist in your payment source configuration
- Fund wallets with sufficient test ADA

#### 4. "Registration timeout"
- Blockchain operations can be slow (5+ minutes)
- Check Cardano network status
- Verify test wallet permissions in database

### Debug Mode

Enable verbose logging:
```bash
DEBUG=* npm run test:e2e:verbose
```

View full API responses:
```bash
NODE_ENV=development npm run test:e2e
```

## 📊 Performance

### Expected Timings
- Server startup: 10-30 seconds
- Registration submission: < 5 seconds  
- Registration confirmation: 2-10 minutes
- Registry queries: < 2 seconds

### Optimization Tips
- Run tests on preprod (faster than mainnet)
- Use dedicated test database
- Parallel test execution (future improvement)
- Cached test data between runs

## 🔐 Security Notes

⚠️ **Never commit real wallet keys to version control**

- Use environment variables for sensitive data
- Test wallets should have minimal funds
- Separate test and production environments
- Regular rotation of test API keys

## 📈 Future Enhancements

### Planned Features
1. **Payment Flow Tests** - Complete payment execution
2. **Purchase Flow Tests** - Buy/sell with refunds
3. **Admin Operation Tests** - Administrative functions
4. **Performance Tests** - Load testing scenarios
5. **Integration Tests** - Cross-service validation

### Improvements
- Parallel test execution
- Test data seeding/cleanup
- Visual test reporting  
- Continuous integration
- Network resilience testing

## 🤝 Contributing

When adding new tests:
1. Follow existing patterns and conventions
2. Add appropriate cleanup logic
3. Include both happy path and error scenarios
4. Update documentation
5. Test on both preprod and mainnet (if applicable)

For questions or issues, refer to the main project documentation or create an issue.