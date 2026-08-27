---
title: Chart transaction financial reporting and exports
label: wayfinder:map
status: open
based_on: feat/transaction-csv-export@ebf6536e
---

## Destination

REPORTED: Give an authorized admin one Payment Source report for transaction-level and aggregated seller revenue, buyer spend, refunds, protocol fees, Cardano transaction fees, and net values. The same filters must drive dashboard cards, history charts, paginated JSON, direct CSV files, and a ZIP package. Reports must cover Web3CardanoV1 and Web3CardanoV2 and calculate on demand from existing payment and purchase records.

## Notes

- Planning only. Do not implement production code in this map.
- VERIFIED: The baseline is `feat/transaction-csv-export` at `ebf6536e`.
- VERIFIED: The current browser export builds ten CSV columns in `frontend/src/pages/transactions.tsx:313` and downloads one client-side file at `frontend/src/pages/transactions.tsx:387`.
- VERIFIED: The current download query sends network, cursor, history, and limit only at `frontend/src/components/transactions/download-details.helpers.ts:12`.
- VERIFIED: Payment and purchase list queries select Web3CardanoV1 by default when source type and address filters are absent at `src/routes/api/payments/queries.ts:17` and `src/routes/api/purchases/queries.ts:17`.
- Local tracker convention: child tickets live in `tickets/`. A ticket is frontier when it is open, unassigned, and every `blocked_by` ticket is closed.

## Confirmed constraints

- REPORTED: Every report requires one accessible Payment Source. It may filter managed wallets, external addresses, buyer or seller role, states, date range, date basis, and revenue mode. Every aggregate must use the same filters as its rows. The selected Payment Source fixes the source version.
- REPORTED: Billable revenue is the default. Cash received and requested gross remain selectable. Seller output separates gross revenue, protocol fees, seller Cardano fees, and net revenue. Buyer output separates gross spend, refunds, buyer Cardano fees, and net spend.
- REPORTED: V1 protocol fees must use the payment source rate and the contract formula during reporting. The report marks a withdrawn fee as calculated and an unlocked ResultSubmitted fee as projected. V2 protocol fees are exact zero. Other states treat the fee as not applicable.
- REPORTED: Each metric uses wide ADA, USDM, and USDCx decimal-string columns in CSV, with no parallel raw columns. Other assets remain raw atomic strings only inside `other_assets_json`. JSON includes raw and decimal strings plus asset metadata.
- REPORTED: Exact per-asset values are the default. Fiat is optional. Supplied rates override configured CoinGecko rates. Bucket-average historical rates are the fiat default, with a per-row accounting-date option. Outputs name the rate mode, source, date, and currency.
- REPORTED: Date basis can be request creation, funds-locked block time, or revenue-recognition time. API time zones default to UTC. The UI sends the browser IANA time zone unless the admin overrides it. Chart buckets switch between daily, weekly, and monthly, with a manual override.
- REPORTED: JSON is paginated. CSV and ZIP responses stream synchronously and are not stored as report jobs. Direct downloads remain available for `transactions.csv`, `wallet-summary.csv`, and `totals.csv`.
- REPORTED: Read permission is sufficient. Payment Source access, wallet scopes, and network limits still apply. Soft-deleted wallets and archived Payment Sources remain reportable when those checks pass, and the output labels them.
- REPORTED: The admin dashboard defaults to 30 days, all wallets, buyer and seller roles, all states, and Billable revenue. It needs cards, history charts, wallet breakdowns, and the expanded transaction export dialog.

## Open tickets

- [Define the reporting metric contract](tickets/define-reporting-metric-contract.md) (`wayfinder:grilling`, frontier)
- [Trace authorization for archived reporting](tickets/trace-archived-report-authorization.md) (`wayfinder:task`, frontier)
- [Define filters and amount representation](tickets/define-filter-and-amount-contract.md) (`wayfinder:grilling`)
- [Fiat conversion contract](tickets/choose-fiat-conversion-contract.md) (`wayfinder:grilling`)
- [Define the shared report query contract](tickets/define-report-query-contract.md) (`wayfinder:grilling`)
- [Streaming export boundary](tickets/choose-streaming-export-boundary.md) (`wayfinder:grilling`)
- [Prototype the dashboard and export flow](tickets/prototype-dashboard-and-export-flow.md) (`wayfinder:prototype`)
- [Set report resource and failure limits](tickets/set-report-resource-and-failure-limits.md) (`wayfinder:grilling`)
- [Finalize the reporting API contract](tickets/define-reporting-api-contract.md) (`wayfinder:grilling`)
- [Confirm cross-format acceptance](tickets/confirm-cross-format-acceptance.md) (`wayfinder:grilling`)

## Decisions so far

- [Research historical fiat rate windows](tickets/research-historical-fiat-rate-windows.md): VERIFIED: one automatic-range call per asset and quote currency can cover the report window. Demo and Basic limit history to one and two years. Missing samples remain unavailable. The fiat and resource tickets must choose averaging, partial coverage, and a commercial plan.

## Not yet specified

- INFERRED: Existing records might not retain enough relation data to enforce historical wallet scopes after deletion. The authorization trace must settle this before the API contract.
- INFERRED: Extending the current payment and purchase endpoints might preserve compatibility better than a new detail endpoint. The response and pagination contract must settle this.
- INFERRED: The supported report range and commercial CoinGecko plan remain unset. The resource-limit ticket must choose them from the verified provider windows and call budget.

## Out of scope

- REPORTED: Scheduled exports and stored report jobs.
- REPORTED: x402 payments, swaps, registry operations, and wallet fund transfers.
- REPORTED: New reporting tables, materialized aggregates, or persistent reporting caches in the first implementation.
- REPORTED: A mandatory fiat conversion when an asset has no approved rate.
