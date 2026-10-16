---
title: Finalize the reporting API contract
label: wayfinder:grilling
status: open
parent: ../map.md
blocked_by:
  - define-report-query-contract.md
  - choose-streaming-export-boundary.md
  - prototype-dashboard-and-export-flow.md
  - set-report-resource-and-failure-limits.md
blocks:
  - confirm-cross-format-acceptance.md
---

## Question

After the query, export, prototype, and resource decisions are closed, which authenticated endpoints and response schemas expose detail rows, totals, chart series, wallet summaries, direct CSV files, and the ZIP package while preserving current clients?

## Confirmed constraints

- REPORTED: Read permission is sufficient. Every request requires an accessible Payment Source and enforces wallet scopes and network limits.
- REPORTED: The UI needs paginated JSON for rows and JSON summaries for cards, charts, and wallet breakdowns.
- REPORTED: Direct CSV endpoints return transactions, wallet summary, or totals. A ZIP endpoint includes all three files.
- REPORTED: V1 and V2 records must be explicit. The selected Payment Source fixes the source version, so reporting must not fall back to the current V1 list default.
- REPORTED: Existing payment and purchase detail endpoints may be extended when that keeps the contract clear. Separate reporting endpoints remain an option.

## Evidence

- VERIFIED: Payment and purchase list queries currently default to Web3CardanoV1 at `src/routes/api/payments/queries.ts:17` and `src/routes/api/purchases/queries.ts:17`.
- VERIFIED: Current income and spending routes use `readAuthenticatedEndpointFactory` and check network limits at `src/routes/api/payments/income/index.ts:149` and `src/routes/api/purchases/spending/index.ts:149`.
- VERIFIED: The current browser export fetches complete list pages and may return pages collected before an error at `frontend/src/components/transactions/DownloadDetailsDialog.tsx:51`.

## Resolve when

- Each route has an exact method, path, input, output, media type, status code, and pagination rule.
- The contract names the shared reporting calculation boundary used by JSON and exports.
- Export status, header commitment, and pre-stream or mid-stream failure behavior match the streaming decision.
- Authorization order and not-found behavior prevent Payment Source or wallet enumeration.
- Compatibility notes state which existing schemas change and which remain unchanged.
