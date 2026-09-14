# Upgrade note — x402 spend caps move to the API key

`prisma/migrations/20260826010000_x402_key_scoped_spend_caps/migration.sql` drops
the `X402WalletBudget` table. Read this before you deploy the release that
contains it. See [ADR 0016](../adr/0016-x402-key-scoped-spend-caps.md) for the
reasoning.

## What changes

| Before                                                                    | After                                                                                      |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| A budget row capped what one API key could spend from one managed wallet. | The API key's usage credits are the only node-side cap.                                    |
| A budget row also granted that key access to a wallet it did not create.  | `ApiKeyX402WalletScope` is the only wallet-access grant.                                   |
| `GET /x402/budgets`, `POST /x402/budgets`                                 | Removed. The endpoints return 404.                                                         |
| Rail readiness reported `x402.budget`.                                    | That check is gone. The x402 list ends at the purchasing wallet, as the Cardano list does. |

## What the migration does to your data

1. **Access is preserved.** Each enabled budget becomes a wallet-scope row when
   the key runs scoped (`x402WalletScopeEnabled`), is not an admin key, and both
   the key and the wallet are live. An unscoped key already reaches every wallet,
   so it gets no row.
2. **Caps are dropped on purpose.** Budget remainders are NOT converted into
   usage credits, and `usageLimited` is NOT switched on. That flag is shared with
   the Cardano rail: switching it on would start failing the same key's Cardano
   purchases until Cardano credits were granted.

**Consequence:** a key that was capped only by a wallet budget spends uncapped
after the upgrade, bounded only by the wallet's on-chain balance. The node logs
nothing at upgrade time. Restore the cap yourself with step 2 below.

## After you deploy

1. List the keys that had a budget before the upgrade. Take this from your
   pre-deploy snapshot, since the table is gone afterwards:
   ```sql
   SELECT "apiKeyId", "evmWalletId", "caip2Network", "asset", "remainingAmount"
   FROM "X402WalletBudget" WHERE "enabled" = true;
   ```
2. Grant each key the equivalent usage credits and cap it:
   ```http
   PATCH /api/v1/api-key
   { "id": "<apiKeyId>",
     "usageLimited": true,
     "UsageCredits": [{ "unit": "eip155:8453:0x<token address>", "amount": "<atomic amount>" }] }
   ```
   The unit is `eip155:<chainId>:<asset address, lowercased>`. The amount is in
   the token's smallest unit.
3. Check the wallet grants that the migration wrote:
   ```sql
   SELECT "apiKeyId", "evmWalletId" FROM "ApiKeyX402WalletScope" WHERE "id" LIKE 'mig_%';
   ```

A usage-limited key needs enough credit in the exact
`eip155:<chainId>:<asset>` unit. A missing or insufficient balance returns HTTP 402. Set `usageLimited` to false only when the key must spend without this
ledger limit.

## Rollback

The migration drops a table, so it is not reversible. Roll back by restoring the
pre-deploy dump. Wallet-scope rows written by the migration carry a `mig_` id
prefix and can be deleted individually if you only need to undo the grants.
