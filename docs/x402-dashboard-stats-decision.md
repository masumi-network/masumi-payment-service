# x402 dashboard stats loading (MAS-570)

## Measurement (2026-10-21)

Method: static review of `useX402DashboardCounts` in `frontend/src/lib/hooks/useX402.ts`.

Per React Query execution (cache miss or explicit refetch):

- 1× `GET /x402/payments/count` (all payments, optional `caip2Network`)
- 1× `GET /x402/settlements/count` (`success=true`)
- 5× `GET /x402/payments/count` (one per status in `X402_PAYMENT_STATUSES`)

Total: **7 parallel HTTP count requests** via `Promise.all`. TanStack Query caches by `['x402-dashboard', 'counts', caip2Network]`; repeat dashboard visits within stale time do not refetch unless invalidated.

No production latency benchmark was run; counts are indexed tenant-scoped reads and the dashboard is operator-only.

## Decision

**Keep the existing fan-out.** Do not add `/x402/stats` on the payment service for this dashboard.

Reasons:

- Each count endpoint already enforces read auth and tenant scope with the same filters (`caip2Network`, status).
- A aggregate endpoint would duplicate query logic and require ongoing parity tests whenever count filters change.
- Seven parallel count queries are acceptable for admin dashboard load; frontend can batch visually with one loading state (already one hook).

## Backend change

None required. Frontend counterpart MAS-557 may document the loading pattern; no new route registration.

## Revisit when

- Dashboard load shows measurable p95 regression on real tenant data, or
- Count endpoints gain heavy joins that make 7× fan-out costly.
