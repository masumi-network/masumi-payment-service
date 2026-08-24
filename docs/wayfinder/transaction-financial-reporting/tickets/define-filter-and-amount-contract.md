---
title: Define filters and amount representation
label: wayfinder:grilling
status: open
parent: ../map.md
blocked_by:
  - define-reporting-metric-contract.md
blocks:
  - choose-fiat-conversion-contract.md
  - define-report-query-contract.md
  - prototype-dashboard-and-export-flow.md
---

## Question

What exact filter fields, defaults, date semantics, and amount shapes must every detail row, aggregate, chart, JSON page, and export share?

## Confirmed constraints

- REPORTED: Every request selects one Payment Source. Optional filters cover managed wallet, external address, buyer or seller role, state, date range, date basis, revenue mode, time zone, and chart bucket. The selected Payment Source fixes the source version.
- REPORTED: External address matching covers payout, return, and counterparty addresses, but remains separate from managed-wallet selection.
- REPORTED: Date basis options are request creation, funds-locked block time, and revenue-recognition time. API defaults to UTC. The UI supplies a browser IANA time zone unless overridden.
- REPORTED: Each metric uses wide ADA, USDM, and USDCx decimal-string columns in CSV, with no parallel raw columns. Other assets use raw strings only inside `other_assets_json`.
- REPORTED: JSON returns atomic strings, decimal strings, and asset metadata. Decimal conversion must not pass monetary values through Number.

## Evidence

- VERIFIED: Existing download filtering uses only `createdAt` at `frontend/src/components/transactions/DownloadDetailsDialog.tsx:141`.
- VERIFIED: PaymentRequest and PurchaseRequest keep buyer and seller return addresses at `prisma/schema.prisma:807` and `prisma/schema.prisma:895`.
- VERIFIED: Transaction records keep Cardano fees and block time at `prisma/schema.prisma:187`.
- VERIFIED: Existing income and spending endpoints accept a time zone at `src/routes/api/payments/income/index.ts:44` and `src/routes/api/purchases/spending/index.ts:44`. They group by local day or month at `src/routes/api/payments/income/index.ts:139` and `src/routes/api/purchases/spending/index.ts:139`.

## Resolve when

- One input schema names all enums, null rules, multi-select behavior, date inclusivity, and defaults.
- One row schema names role, state, source version, managed wallet, external addresses, accounting timestamp, fee provenance, and all amount fields.
- The wallet summary defines its grouping key, role handling, deleted label, and missing-wallet behavior. It states whether external addresses are filters only or also groups.
- PaymentRequest maps to seller reporting and PurchaseRequest maps to buyer reporting. Wallet summary amounts must reconcile with filtered totals.
- CSV headers and JSON asset objects are exact. They define ADA, USDM, USDCx, and `other_assets_json` behavior.
- The contract states how filters compose and how empty results differ from invalid filters.
