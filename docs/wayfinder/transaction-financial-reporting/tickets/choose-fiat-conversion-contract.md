---
title: Choose the fiat conversion contract
label: wayfinder:grilling
status: open
parent: ../map.md
blocked_by:
  - define-reporting-metric-contract.md
  - research-historical-fiat-rate-windows.md
  - define-filter-and-amount-contract.md
blocks:
  - define-report-query-contract.md
  - prototype-dashboard-and-export-flow.md
  - set-report-resource-and-failure-limits.md
---

## Question

How should supplied rates and CoinGecko historical data produce repeatable bucket-average or per-row fiat values without changing exact asset totals?

## Confirmed constraints

- REPORTED: Fiat is optional. Exact per-asset totals remain authoritative.
- REPORTED: A supplied asset rate wins. CoinGecko may fill only missing rates when configured.
- REPORTED: Charts and exports default to one average historical rate per bucket. A caller may select a rate at each row's accounting date.
- REPORTED: Every fiat result carries its currency, source, method, and rate date or date range.

## Evidence

- VERIFIED: The current invoice path combines caller mappings with CoinGecko results at `src/routes/api/invoice/monthly/shared.ts:293`.
- VERIFIED: The current invoice path fails when an asset still has no conversion at `src/routes/api/invoice/monthly/shared.ts:393`.
- VERIFIED: Invoice output types keep conversion factor, decimals, unit, and conversion date at `src/utils/invoice/template.ts:92`.

## Resolve when

- Precedence, rate lookup identity, request-scoped deduplication, rounding, precision, and missing-rate behavior are exact.
- Bucket-average and per-row formulas name their timestamp source and provider observations.
- JSON and CSV metadata can reproduce which rate affected each value.
- Provider failure cannot prevent the default exact-asset report.
- Client construction selects `demoAPIKey` or `proAPIKey` to match the configured CoinGecko environment.
