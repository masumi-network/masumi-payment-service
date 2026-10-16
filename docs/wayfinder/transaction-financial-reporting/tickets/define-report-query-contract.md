---
title: Define the shared report query contract
label: wayfinder:grilling
status: open
parent: ../map.md
blocked_by:
  - trace-archived-report-authorization.md
  - define-filter-and-amount-contract.md
  - choose-fiat-conversion-contract.md
blocks:
  - choose-streaming-export-boundary.md
  - prototype-dashboard-and-export-flow.md
  - set-report-resource-and-failure-limits.md
  - define-reporting-api-contract.md
---

## Question

What shared report contract can serve the dashboard and every export before HTTP transport details are final while defining calculation boundaries plus row and summary shapes and stable order?

## Confirmed constraints

- REPORTED: One accessible Payment Source is mandatory. The selected source fixes network and source version.
- REPORTED: Filtered detail JSON uses pagination. Summary JSON supplies cards, chart series, wallet summaries, and totals.
- REPORTED: Rows and summaries use the same metric, wallet-grouping, asset, date, state, role, and fiat rules.
- REPORTED: Calculation remains on demand from PaymentRequest and PurchaseRequest records in the first implementation.

## Evidence

- VERIFIED: Existing payment income and purchase spending endpoints already calculate asset totals and time series at `src/routes/api/payments/income/index.ts:149` and `src/routes/api/purchases/spending/index.ts:149`.
- VERIFIED: Existing list endpoints apply wallet scope filters at `src/routes/api/payments/queries.ts:40` and `src/routes/api/purchases/queries.ts:43`.
- VERIFIED: PaymentRequest keeps source and wallet IDs from `prisma/schema.prisma:774`, then state, fee, transaction, and amount fields through `prisma/schema.prisma:821`. PurchaseRequest keeps the corresponding fields from `prisma/schema.prisma:860` through `prisma/schema.prisma:909`.

## Resolve when

- Domain inputs and outputs are exact and do not depend on CSV, ZIP, or React types.
- Detail and summary models use one vocabulary: metric names, amount shapes, fee provenance, wallet keys, and accounting timestamps.
- Pagination is exact. The resolution defines stable sort, snapshot assumptions, and empty-result behavior.
- Authorization inputs come from authenticated context rather than caller-supplied scope IDs.
