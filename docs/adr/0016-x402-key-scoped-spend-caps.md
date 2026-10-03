# 0016: x402 spend caps live on the API key, not on the wallet

## Status

Accepted. Amends ADR 0008 decision 2: the rail-specific "wallet budgets"
table is removed.

## Context

ADR 0008 gave the x402 rail a per-`(API key, wallet, asset)` budget table
(`X402WalletBudget`). In practice one row carried two unrelated meanings
at once: a spend cap, and an implicit delegation that let a non-owner key
spend from a foreign wallet. The Cardano rail has neither concept on the
wallet: a key's cap is its global usage-credit ledger
(`ApiKey.usageLimited` + `UnitValue` rows), and wallet access is the
key's wallet scope. Running both models side by side produced three caps
on one payment (budget, credits, on-chain balance) and integration bugs
in clients that had to reason about which cap binds when.

## Decision

Mirror Cardano exactly. The key-global usage-credit ledger (units
`eip155:<chainId>:<asset>`) is the only x402 spend cap; a non-admin key
reaches a wallet only through ownership (`createdById`) or its
`ApiKeyX402WalletScope` list, while an admin key (`canAdmin`) stays
unrestricted. `X402WalletBudget` and
`GET/POST /x402/budgets` are removed outright, with no compatibility
shim. The migration converts each enabled budget into a wallet-scope
assignment (access survives) and deliberately does NOT convert budget
remainders into credits: `usageLimited` is shared with the Cardano rail,
and flipping it on budget-holding keys would start failing their Cardano
purchases. A key that was capped only by a wallet budget is uncapped
after the migration until an operator grants it usage credits.

## Consequences

- A per-wallet cap can no longer be expressed. The cap dimension is
  per-key per-`(chain, asset)`.
- Clients that read `/x402/budgets` (the dashboard's Budgets tab,
  Sokosumi's buy-side readiness sync) must move to `api-key-status`
  usage credits plus wallet scopes.
- The rail-readiness `x402.budget` check is removed; the check list ends
  at `x402.purchasing_wallet`, matching the Cardano rail's list.
