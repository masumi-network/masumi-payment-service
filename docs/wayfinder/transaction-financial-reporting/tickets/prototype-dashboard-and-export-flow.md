---
title: Prototype the dashboard and export flow
label: wayfinder:prototype
status: open
parent: ../map.md
blocked_by:
  - define-filter-and-amount-contract.md
  - choose-fiat-conversion-contract.md
  - define-report-query-contract.md
blocks:
  - define-reporting-api-contract.md
---

## Question

Which dashboard hierarchy and export controls let an admin understand seller revenue or buyer spend, narrow one Payment Source, and download the same filtered data without hiding fee or fiat assumptions?

## Prototype brief

Build a rough artifact with the existing admin design system. Include cards, a history chart, wallet breakdown, shared filters, metric explanations, empty and partial-fiat states, and direct or ZIP download choices. Ask the user to react to the artifact before production UI work.

## Confirmed constraints

- REPORTED: Default view is 30 days, all wallets, buyer and seller roles, all states, Billable revenue, and the browser IANA time zone.
- REPORTED: Buckets default to daily for 30 days, weekly through one year, and monthly beyond one year. Manual override remains available.
- REPORTED: The Transactions download dialog expands rather than moving export into a separate product area.
- REPORTED: Cards and charts show gross, fees, refunds, and net as distinct values. Fiat views state their rate method and source.

## Evidence

- VERIFIED: `wc -l frontend/src/pages/transactions.tsx` returned `740 frontend/src/pages/transactions.tsx` on 2026-08-24.
- VERIFIED: The current Transactions page owns CSV generation and download behavior at `frontend/src/pages/transactions.tsx:313`.
- VERIFIED: The current download dialog exposes date presets and custom dates at `frontend/src/components/transactions/DownloadDetailsDialog.tsx:45`.

## Resolve when

- The artifact covers default, filtered, empty, loading, error, archived-wallet, and missing-fiat states.
- User feedback chooses the card order, chart metric control, wallet breakdown, and export control placement.
- The resolution states which view, model, and shared components own each concern.
- Production work can keep `frontend/src/pages/transactions.tsx` below the 750-line source-file limit.
