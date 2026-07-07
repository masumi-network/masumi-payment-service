# End-to-end testing

The e2e suite exercises full payment flows against the **real Cardano Preprod
blockchain** with a locally running server and a dedicated database. Expect a
full run to take 10–20 minutes because it waits for on-chain confirmations.

## One-time setup

1. Create a dedicated test database (never reuse your dev database):

   ```bash
   createdb masumi_payment_service_test
   ```

2. In `.env`, point `DATABASE_URL` at the test database and set the e2e
   variables (see the `CONFIG for E2E TESTING` block in `.env.example`):
   - `TEST_API_KEY` — must match a seeded API key (22 characters recommended)
   - `TEST_NETWORK` — usually `Preprod`
   - `TEST_API_URL` — usually `http://localhost:3001`

3. Run migrations and seed the test data:

   ```bash
   pnpm run prisma:migrate:dev
   pnpm run prisma:seed
   ```

## Running

Start the server, then run the suite:

```bash
pnpm run dev          # terminal 1 — server must be running
pnpm run test:e2e     # terminal 2
```

Run a single flow:

```bash
pnpm run test:e2e -- tests/e2e/flows/complete-flow-with-refund.test.ts
```

Scope the run to one payment source type (see `jest.e2e.config.ts`):

```bash
TEST_PAYMENT_SOURCE_TYPE=Web3CardanoV1 pnpm run test:e2e   # tests/e2e/flows/
TEST_PAYMENT_SOURCE_TYPE=Web3CardanoV2 pnpm run test:e2e   # tests/e2e/v2/flows/
```

## Notes

- Always use the pnpm scripts, never bare `npx jest` — see
  [development.md](development.md#testing).
- E2E tests run sequentially (`maxWorkers: 1`) because flows mutate shared
  on-chain and database state.
- Tests spend real (test-)ADA on Preprod; the funding wallets must hold enough
  tADA. Ask a maintainer or use the [Cardano faucet](https://docs.cardano.org/cardano-testnets/tools/faucet/)
  to top up.
- CI runs V1 and V2 flows in parallel jobs (`.github/workflows/e2e.yml`) with
  `cancel-in-progress` to avoid UTxO contention between runs.
