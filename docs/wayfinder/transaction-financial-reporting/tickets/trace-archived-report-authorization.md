---
title: Trace authorization for archived reporting
label: wayfinder:task
status: open
parent: ../map.md
blocked_by: []
blocks:
  - define-report-query-contract.md
---

## Question

How can reports include soft-deleted wallets and archived Payment Sources while still enforcing Read permission, Payment Source access, wallet scopes, and network limits?

## Task

Trace the authenticated request context into payment and purchase queries. Record which stable IDs remain on historical rows after wallet or Payment Source deletion. Test whether scoped and unscoped keys can distinguish the same archived records. Do not change deletion or authorization behavior in this ticket.

## Confirmed constraints

- REPORTED: One accessible Payment Source is mandatory for each report request.
- REPORTED: Scoped credentials may see only matching managed wallets. Network limits still apply.
- REPORTED: Archived Payment Sources and soft-deleted wallets remain reportable when the caller still has access. The output labels deleted records.
- REPORTED: External payout, return, and counterparty addresses are separate filters. They do not grant access by themselves.

## Evidence

- VERIFIED: `buildWalletScopeFilter` limits requests by `smartContractWalletId` at `src/utils/shared/wallet-scope.ts:3`.
- VERIFIED: Current payment queries exclude deleted Payment Sources at `src/routes/api/payments/queries.ts:34` and deleted SmartContractWallet relations at `src/routes/api/payments/queries.ts:49`.
- VERIFIED: PaymentSource has `deletedAt` at `prisma/schema.prisma:976` and keeps HotWallet, PaymentRequest, and PurchaseRequest relations from `prisma/schema.prisma:984`.
- VERIFIED: PaymentRequest retains Payment Source and smart-contract wallet IDs at `prisma/schema.prisma:774`. PurchaseRequest retains those IDs at `prisma/schema.prisma:860`.

## Resolve when

- A data-flow note names each authorization check and its order.
- Tests or query probes show allowed and denied behavior for active, deleted, scoped, unscoped, and wrong-network cases.
- The ticket identifies any missing historical relation that would require a migration.
- The API ticket receives a clear authorization rule or an explicit blocker.
