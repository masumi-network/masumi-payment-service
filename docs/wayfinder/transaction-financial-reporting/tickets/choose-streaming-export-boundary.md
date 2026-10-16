---
title: Choose the streaming export boundary
label: wayfinder:grilling
status: open
parent: ../map.md
blocked_by:
  - define-report-query-contract.md
blocks:
  - set-report-resource-and-failure-limits.md
  - define-reporting-api-contract.md
---

## Question

How should the service stream direct CSV and ZIP responses from one filtered calculation path while keeping files complete, internally consistent, and safe under disconnects or query failures?

## Confirmed constraints

- REPORTED: Exports run synchronously. The service does not create stored report jobs.
- REPORTED: Direct files are `transactions.csv`, `wallet-summary.csv`, and `totals.csv`. The ZIP package contains those same files.
- REPORTED: All files use the same Payment Source, wallet, address, role, state, date range, date basis, mode, and time-zone filters. They also use the same asset representation and fiat conversion settings. The selected Payment Source fixes the source version.
- REPORTED: Each metric uses wide ADA, USDM, and USDCx decimal-string columns in CSV, with no parallel raw columns. Other assets remain as raw atomic strings only in `other_assets_json`.

## Evidence

- VERIFIED: The current UI creates one CSV Blob in browser memory at `frontend/src/pages/transactions.tsx:387`.
- VERIFIED: Its CSV encoder doubles quotation marks and quotes every field at `frontend/src/pages/transactions.tsx:374`.
- VERIFIED: The current download loop treats a failed page as the end of available data and can return earlier pages at `frontend/src/components/transactions/DownloadDetailsDialog.tsx:58`.

## Resolve when

- The ticket defines when headers become committed and how a pre-stream or mid-stream failure reaches the caller.
- Direct files and ZIP members share column definitions, sort order, totals, metadata, and snapshot semantics.
- The approach states its memory bound and cancellation behavior without adding a report-job subsystem.
- CSV injection handling, RFC 4180 encoding, filenames, and content-disposition behavior are exact.
