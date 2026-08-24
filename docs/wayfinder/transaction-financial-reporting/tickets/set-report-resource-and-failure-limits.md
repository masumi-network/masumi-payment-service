---
title: Set report resource and failure limits
label: wayfinder:grilling
status: open
parent: ../map.md
blocked_by:
  - choose-fiat-conversion-contract.md
  - define-report-query-contract.md
  - choose-streaming-export-boundary.md
blocks:
  - define-reporting-api-contract.md
---

## Question

What row, date-range, page, provider-call, memory, and time limits keep paginated JSON and synchronous exports predictable on supported networks?

## Confirmed constraints

- REPORTED: JSON uses pagination. CSV and ZIP stream without background jobs.
- REPORTED: Network and wallet limits apply before report work begins.
- REPORTED: Fiat provider failure must not block an exact per-asset report.
- REPORTED: The implementation may add query indexes when measurements show that existing indexes do not support the final filter and sort contract.

## Evidence

- VERIFIED: PaymentRequest already has indexes for creation time, Payment Source plus creation time, Payment Source plus state, and Payment Source plus pay-by time at `prisma/schema.prisma:826`.
- VERIFIED: PurchaseRequest has matching state and time indexes starting at `prisma/schema.prisma:911`.
- VERIFIED: Current export pagination uses 100 rows per request at `frontend/src/components/transactions/download-details.helpers.ts:10`.
- VERIFIED: V2 transaction fees can be shared across multiple request entries at `src/services/transactions/tx-sync/util/index.ts:497`.

## Resolve when

- Limits are numeric and tied to a measured query, serialization, memory, or provider-call cost.
- The contract covers JSON page size, synchronous export range or row cap, timeout, disconnect, and cancellation.
- Errors distinguish invalid filters, forbidden scope, missing rates, provider failure, limit excess, and internal failure.
- The plan names any required index and the query shape that uses it.
