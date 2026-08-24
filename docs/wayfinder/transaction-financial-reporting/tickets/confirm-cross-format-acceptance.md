---
title: Confirm cross-format acceptance
label: wayfinder:grilling
status: open
parent: ../map.md
blocked_by:
  - define-reporting-api-contract.md
blocks: []
---

## Question

What acceptance evidence proves that dashboard values, paginated JSON, each direct CSV, and every ZIP member apply the same filters, formulas, wallet groups, amount precision, and fiat metadata?

## Confirmed constraints

- REPORTED: State and wallet filters affect rows and every aggregate.
- REPORTED: `transactions.csv`, `wallet-summary.csv`, and `totals.csv` are available directly and inside the ZIP package.
- REPORTED: Exact assets remain authoritative when fiat is disabled or unavailable.
- REPORTED: V1 and V2, active and archived records, buyer and seller roles, and all revenue modes need acceptance coverage.

## Evidence

- VERIFIED: Current CSV values are built separately in the Transactions page at `frontend/src/pages/transactions.tsx:313`.
- VERIFIED: Current income and spending summaries use independent route implementations at `src/routes/api/payments/income/index.ts:149` and `src/routes/api/purchases/spending/index.ts:149`.

## Resolve when

- A test matrix covers formulas, filters, permission boundaries, deleted records, pagination, streaming failures, and asset conversion.
- For one fixed data snapshot, detail rows sum to wallet summaries and totals for every metric and asset.
- Direct CSV files and ZIP members use the same schemas, ordering, metadata, and escaping rules.
- UI acceptance names the displayed metric, time zone, bucket, fiat method, and active filters for every chart or total.
