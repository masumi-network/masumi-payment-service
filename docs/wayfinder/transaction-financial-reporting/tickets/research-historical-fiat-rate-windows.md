---
title: Research historical fiat rate windows
label: wayfinder:research
status: closed
parent: ../map.md
assignee: fiat_rate_research
blocked_by: []
blocks:
  - choose-fiat-conversion-contract.md
---

## Question

Can the configured CoinGecko API supply auditable historical prices for bucket-average and per-row conversion across the required date ranges, assets, currencies, and request limits?

## Resolution

Resolved 2026-08-24 from official CoinGecko documentation and the installed `@coingecko/coingecko-typescript@2.0.0` package.

### Range behavior

- VERIFIED: [`GET /coins/{id}/market_chart/range`](https://docs.coingecko.com/reference/coins-id-market-chart-range) and [`GET /coins/{platform}/contract/{address}/market_chart/range`](https://docs.coingecko.com/reference/contract-address-market-chart-range) return timestamped price samples for one asset and one quote currency. They accept UNIX time or ISO `YYYY-MM-DD` and `YYYY-MM-DDTHH:MM` values.
- VERIFIED: Automatic granularity is five minutes for the current day, hourly for historical ranges through 90 days, and daily at 00:00 UTC above 90 days. Explicit hourly ranges allow 100 days per request. Explicit five-minute ranges allow 10 days and require Enterprise.
- VERIFIED: The endpoints return samples, not report-bucket averages. The application must calculate and label its own average.
- VERIFIED: Data availability depends on when CoinGecko started tracking each asset. A requested window can return partial coverage.

### Plan and call limits

VERIFIED: The [CoinGecko pricing table](https://www.coingecko.com/en/api/pricing) publishes these current limits.

| Plan    |                 Historical window | Monthly call credits | Calls per minute |
| ------- | --------------------------------: | -------------------: | ---------------: |
| Demo    |                            1 year |               10,000 |              100 |
| Basic   |                           2 years |              100,000 |              300 |
| Analyst | Daily from 2013, hourly from 2018 |              500,000 |              500 |

VERIFIED: For one quote currency, the range method needs three asset calls for ADA, USDM, and USDCx. A cold request adds one coin-list call and one supported-currency call. Per-date history needs one call per asset and distinct UTC date.

| Range      | Range calls | Cold range total | Per-date history calls |
| ---------- | ----------: | ---------------: | ---------------------: |
| 30 days    |           3 |                5 |                     90 |
| 365 days   |           3 |                5 |                  1,095 |
| 1,095 days |           3 |                5 |                  3,285 |

VERIFIED: These counts use 30, 365, and 1,095 distinct UTC dates. Each leap day adds three per-date history calls.

- VERIFIED: Each extra quote currency adds three range calls. Per-date history returns all quote currencies in one response.
- VERIFIED: The installed SDK defaults to two retries at `node_modules/@coingecko/coingecko-typescript/client.d.ts:81`. One logical request can make three HTTP attempts.
- VERIFIED: [`GET /key`](https://docs.coingecko.com/reference/key) reports the active plan and request limits. Configuration alone does not attest the subscribed plan.

### Reporting consequences

- VERIFIED: The [attribution guide](https://brand.coingecko.com/resources/attribution-guide) requires visible attribution near displayed data and a link to CoinGecko or its API page.
- INFERRED: Preserve exact asset values and return null fiat fields with a structured reason when mapping, plan access, provider calls, or sample coverage fail. Never substitute a current price.
- INFERRED: A candidate bucket method is the arithmetic mean of valid samples. Its metadata must state cadence, sample count, first and last timestamps, asset identity, quote currency, and fetch time. The fiat contract must still choose arithmetic or time-weighted averaging and a partial-sample threshold.
- INFERRED: USDCx and USDM can have shorter histories than ADA. The implementation must disclose the actual first and last samples instead of promising the full requested range.
- VERIFIED: The invoice client passes `demoAPIKey` even when it selects the Pro environment at `src/routes/api/invoice/monthly/shared.ts:320`. The installed SDK has separate `proAPIKey` and `demoAPIKey` options at `node_modules/@coingecko/coingecko-typescript/client.d.ts:37`. Pro reporting must select the matching key field.

### Downstream decisions

- The resource-limit ticket must set the maximum range and required CoinGecko plan.
- The fiat contract must set the average formula, partial-sample threshold, unavailable-rate shape, attribution placement, and commercial redistribution rule.
- The implementation route must fix Demo versus Pro client authentication before it depends on paid history.

## Research brief

Use official CoinGecko documentation and the installed SDK contract. Record the supported historical endpoints, date precision, range limits, currency coverage, plan limits, attribution rules, error behavior, and batching options. Check ADA, USDM, and USDCx identity mapping. Do not treat a current price as a historical average.

## Confirmed constraints

- REPORTED: Exact per-asset reporting remains the default and must work without fiat.
- REPORTED: User-supplied rates override provider rates. Configured CoinGecko fills only missing rates.
- REPORTED: Bucket-average historical rates are the default fiat method. Per-row accounting-date rates remain optional.
- REPORTED: Outputs name fiat currency, source, method, and applicable rate dates.

## Evidence

- VERIFIED: Monthly invoice conversion first reads caller mappings, then resolves missing assets through CoinGecko at `src/routes/api/invoice/monthly/shared.ts:293`.
- VERIFIED: The current code requests one historical date based on invoice creation time at `src/routes/api/invoice/monthly/shared.ts:315` and `src/routes/api/invoice/monthly/shared.ts:345`.
- VERIFIED: The current code treats ADA, USDM, and USDCx as six-decimal assets at `src/routes/api/invoice/monthly/shared.ts:353`.

## Resolve when

- Findings link to official documentation and quote exact endpoint or plan limits.
- A small call-count model covers 30 days, one year, and a multi-year range for three default assets.
- The ticket states which average can be computed from provider data and what happens when a rate is unavailable.
- The ticket names any assumption that needs a product or billing-plan decision.
