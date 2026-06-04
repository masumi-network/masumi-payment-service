# 0008: Standard EVM x402 Payment Rail

## Status

Accepted.

## Context

ADR 0004 keeps Masumi escrow contract families behind `PaymentSourceType`
and per-type Cardano service packages. Standard x402 is different: it is
an HTTP payment protocol whose EVM settlement payloads are verified and
settled through the x402 SDK, not through a Masumi Cardano escrow
contract.

The service also has existing Cardano `/payment/x402` transaction-builder
routes. Those routes are historical Cardano-specific APIs and must remain
wire-compatible with `Mainnet` / `Preprod` request and response schemas.

## Decision

1. Implement standard EVM x402 as a separate rail in
   `@masumi/payment-source-x402`, not as a new `PaymentSourceType`.
2. Add rail-specific tables for x402 networks, managed EVM wallets,
   wallet budgets, payment attempts, and settlements.
3. Use CAIP-2 identifiers internally. Existing Cardano API schemas keep
   accepting and returning `Mainnet` / `Preprod`; API-key chain limits are
   stored as `cardano:*` and `eip155:*` strings.
4. Keep x402 SDK and `viem` imports inside
   `@masumi/payment-source-x402`. The main app adds only route/auth
   wiring under `/api/v1/x402`.
5. Split the rail by x402 role. The buy side (`canPay`) signs a payment
   for a 402 the caller forwards, charges it against a managed wallet
   budget, and returns the `X-PAYMENT` header for the caller to send with
   its own request — the service never fetches the resource itself. The
   sell side (`canPay`) is an x402 facilitator that verifies and settles
   inbound payments for a registered resource. `canAdmin` manages x402
   rail config, wallets, networks, and budgets.
6. V1 Cardano registry behavior stays frozen and does not advertise x402.
   V2 registry entries may advertise x402 Supported Payment Sources.

## Consequences

This intentionally diverges from ADR 0004 for x402. The divergence is
local: Cardano escrow families still use `PaymentSourceType`; x402 uses
rail tables because its protocol semantics are EVM authorization
(Permit2), facilitator verify/settle, and settlement replay protection.

The buy side is a thin signing abstraction plus a wallet store: the
caller's agent hits a 402 itself and forwards the requirements, the
service signs from a managed wallet and returns the `X-PAYMENT` header,
and the agent continues its own request. The service therefore never
performs an outbound resource fetch, so there is no SSRF surface and no
proxied response to cache.

Managed wallet spend is bounded by API-key CAIP-2 chain limits and
wallet budget rows before a payment payload is signed. On the sell side,
settlements are deduplicated by canonical x402 payment payload hash, and
a replay is honored only when it is bound to the same registered source.

References:

- x402 docs: https://docs.x402.org/
- x402 payment-identifier extension: https://docs.x402.org/extensions/payment-identifier
- CAIP-2: https://standards.chainagnostic.org/CAIPs/caip-2
