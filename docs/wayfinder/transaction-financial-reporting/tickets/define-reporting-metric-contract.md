---
title: Define the reporting metric contract
label: wayfinder:grilling
status: open
parent: ../map.md
blocked_by: []
blocks:
  - define-filter-and-amount-contract.md
  - choose-fiat-conversion-contract.md
---

## Question

What exact row-level and aggregate formulas define seller revenue, buyer spend, refunds, protocol fees, Cardano transaction fees, and net values for every relevant state, source version, and revenue mode?

## Confirmed constraints

- REPORTED: Billable is the default revenue mode. It includes Withdrawn, unlocked ResultSubmitted, and the seller share of DisputedWithdrawn.
- REPORTED: Cash received includes Withdrawn and DisputedWithdrawn. Requested gross includes requested amounts even when they remain pending or later refund, subject to selected state filters.
- REPORTED: Seller metrics show gross revenue, protocol fees, seller Cardano fees, and net revenue separately. Protocol fees reduce their own asset units. Seller Cardano fees reduce ADA only.
- REPORTED: Buyer metrics show gross spend, returned assets, buyer Cardano fees, and net spend separately. Returned assets reduce their own units. Buyer Cardano fees increase ADA spend only.
- REPORTED: V1 protocol fees use the selected Payment Source rate and current contract formula. V2 protocol fees are exact zero. Reports distinguish calculated, projected, zero, and not-applicable values.

## Evidence

- VERIFIED: PaymentRequest stores both Cardano fee totals, RequestedFunds, WithdrawnForBuyer, and WithdrawnForSeller at `prisma/schema.prisma:814`.
- VERIFIED: PurchaseRequest stores both Cardano fee totals, PaidFunds, WithdrawnForBuyer, and WithdrawnForSeller at `prisma/schema.prisma:883`.
- VERIFIED: V1 collection calculates a proportional fee for every asset and applies a lovelace minimum at `packages/payment-source-v1/src/services/payments/collection/service.ts:181`. The minimum is `1435230n` at `packages/payment-core/src/config.ts:326`.
- VERIFIED: V2 collection assigns zero protocol fees at `packages/payment-source-v2/src/services/payments/collection/service.ts:172`.
- VERIFIED: Transaction sync attributes seller and buyer Cardano fees by redeemer at `src/services/transactions/tx-sync/util/index.ts:123` and splits a batch fee across entries at `src/services/transactions/tx-sync/util/index.ts:497`.
- VERIFIED: Disputed withdrawal uses an admin-paid redeemer and assigns its Cardano fee to neither buyer nor seller at `src/services/transactions/tx-sync/util/index.ts:143`.
- VERIFIED: PaymentSource stores `feeRatePermille` at `prisma/schema.prisma:973`.

## Resolve when

- One state table defines the asset source, sign, accounting date, and inclusion rule for each metric and revenue mode.
- The table covers V1 and V2, including disputed splits, refunds, pending rows, unlocked ResultSubmitted, and missing history.
- Protocol fee rate and amount are separate row and aggregate fields for each applicable asset.
- Admin-paid or otherwise unattributed Cardano fees have an explicit reconciliation rule. Buyer, seller, admin, and total fee values reconcile when transaction history supplies the total.
- The contract defines zero, null, not applicable, calculated, and projected without overloading one value.
- The formulas use BigInt atomic amounts before any decimal or fiat conversion.
