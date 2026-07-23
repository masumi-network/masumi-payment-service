# 0010: Registry Entry Type Discriminator (Standard / OpenApi / X402)

## Status

Accepted.

## Context

A registry entry historically described exactly one agent access model: a single
`apiBaseUrl` the caller interacts with. We need to advertise two additional
access models without forking the registration pipeline:

- **OpenApi** — the agent is described by an OpenAPI 3.1.x specification document
  (JSON or YAML) instead of a bare base URL.
- **X402** — the agent exposes a *loose set of independently addressable
  resources* (the x402 access model), described by a self-hosted manifest.

These are **access models, not payment rails**. An x402-style agent can still be
paid via Cardano/Masumi or EVM x402; payment is expressed independently through
`supportedPaymentSources` (see ADR 0008). The existing `InboxAgentRegistrationRequest`
is a *separate* table because it is a stripped-down record; the new types instead
keep the entire standard field set (author, legal, capability, tags, pricing,
example outputs, verifications, wallet + transaction lifecycle).

Research into x402 discovery (Coinbase x402 specs, x402.org, Nov 2025) found:
x402 has **no per-agent grouping** and **no standardized per-agent manifest** —
discovery is a flat, facilitator-aggregated Bazaar catalog keyed by individual
resource URL. An agent may expose hundreds of resources.

## Decision

1. **Single table, not new tables.** Add a `type RegistryEntryType`
   (`Standard | OpenApi | X402`) column to `RegistryRequest`, defaulting to
   `Standard`. The two new types share the whole registry field set and the
   entire mint/sync/state-machine/deregister pipeline; duplicating that into
   per-type tables (the inbox pattern) is unwarranted here.

2. **Backwards compatible by construction.** `Standard` emits **no** on-chain
   `type` field, so its metadata is byte-identical to entries minted before this
   change, and an absent (or unrecognised) on-chain `type` resolves back to
   `Standard`. A migration backfills all existing rows to `Standard`.

3. **Per-type endpoint descriptor, mutually exclusive** (enforced at the API
   boundary, `apiBaseUrl` made nullable):
   - `Standard` → `apiBaseUrl`
   - `OpenApi` → `openApiSpecUrl` (URL to an OpenAPI 3.1.x doc; JSON or YAML —
     the doc self-declares its version, so the type string carries none)
   - `X402` → `x402ResourcesUrl` (URL to a self-hosted resource manifest, see
     [x402-agent-manifest.md](../x402-agent-manifest.md))

4. **On-chain `type` string values** differ from the Prisma enum identifiers and
   carry no `Masumi` prefix (unlike the inbox `MasumiInboxV*`): `Standard` →
   absent, `OpenApi` → `"OpenAPI"`, `X402` → `"x402V1"`. Mapping and the reverse
   parser live in `@masumi/payment-core/registry-entry-type`.

5. **x402 resources are referenced by URL, never inlined on chain.** Cardano
   transaction-size limits cannot carry a large resource set inline. Only the
   manifest URL is stored; the indexer fetches and parses it into a catalog
   **grouped by agent** — the grouping x402 itself lacks. Pricing stays
   agent-level (`supportedPaymentSources`); the manifest carries only resource
   URL, transport type, and optional input/output JSON Schema.

6. **Frontend surfaces the type as a filter, not separate tabs** — one list
   endpoint with a `type` filter, and per-type fields in the registration form.

## Consequences

- One migration, one pipeline; new types inherit funding, collateral prep,
  retry, transaction lifecycle, deregister and update for free.
- The indexer (masumi-registry-service) must recognise `OpenAPI` / `x402V1`,
  store the URLs, fetch+parse the x402 manifest, and treat absent/unknown `type`
  as `Standard`. It should also recognise `MasumiInboxV2` (a pre-existing gap:
  the indexer only knew `MasumiInboxV1`).
- Masumi defines the x402 manifest format because x402 does not standardize one;
  a breaking change bumps the on-chain type (`x402V1` → `x402V2`).
