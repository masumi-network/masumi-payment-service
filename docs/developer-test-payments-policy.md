# Developer test payments (server policy)

## Decision

Server enforcement **is required** for dashboard developer test flows. Regular payment and purchase initialization must stay unchanged on Mainnet.

## Allowed networks

When `developerTestIntent` is `true`:

- **Preprod** is allowed (subject to API key `networkLimit` and `canPay` as today).
- **Mainnet** is rejected with **403** before any on-chain work starts.

When `developerTestIntent` is omitted or `false`, no extra test policy applies. Mainnet production use continues through the same endpoints.

## How test actions are identified

The Developers → Testing UI sets optional body field `developerTestIntent: true` on:

- `POST /api/v1/payment` (payment init)
- `POST /api/v1/purchase` (purchase init)

Integrations and curl examples that omit the field are not treated as developer tests.

## Coordination

Frontend counterpart: Linear MAS-525 (all Testing tab entry points must send `developerTestIntent: true`).

## Verification

Automated unit tests cover Mainnet rejection and Preprod allowance when the flag is set. Do not submit Mainnet transactions to verify the gate.
