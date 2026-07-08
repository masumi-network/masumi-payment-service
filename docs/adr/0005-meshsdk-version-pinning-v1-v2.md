# ADR 0005 — Mesh SDK version pinning per payment source type

## Status

Accepted.

## Context

The codebase uses two distinct lines of Mesh SDK across the V1 and V2 payment
source types:

| Package                                  | `@meshsdk/core`      | `@meshsdk/core-cst`   | Used for             |
| ---------------------------------------- | -------------------- | --------------------- | -------------------- |
| repo root (`package.json`)               | `1.9.0-beta.96`      | `1.9.0-beta.90`       | shared + V1 services |
| `packages/payment-core`                  | — (no direct dep)    | `1.9.0-beta.90`       | shared, V1-aligned   |
| `packages/payment-source-v1`             | `1.9.0-beta.96`      | `1.9.0-beta.90`       | V1 services          |
| `packages/payment-source-v2`             | `1.9.0-beta.102`     | `1.9.0-beta.102`      | V2 services          |

This split is intentional and load-bearing. Mesh SDK upgrades change the
following observable outputs over time:

1. **Script address derivation.** `applyParamsToScript` /
   `resolvePlutusScriptAddress` can produce different `smartContractAddress`
   values for the same Aiken script source if the underlying Cardano
   serialization library version changes (for example because of canonical CBOR
   tweaks or PlutusScriptV3 encoding fixes). Our seed (`prisma/seed.ts`) hard
   asserts that the derived V1 contract address equals
   `DEFAULTS.PAYMENT_SMART_CONTRACT_ADDRESS_PREPROD`. Upgrading V1's mesh away
   from `beta.96` / `beta.90` would change that derived address and break
   compatibility with every existing on-chain V1 contract instance, every
   already-locked UTxO, and every legacy registry policy id.

2. **Script integrity hash (`PPViewHashesDontMatch`).** Mesh bundles cost
   models for each Plutus language version. The transaction-body
   `script_data_hash` is computed from these cost models together with the
   redeemers and datums in the witness set. If a tx is built with mesh's
   bundled cost models but the chain expects a different cost model set, the
   ledger rejects the submission with `ConwayUtxowFailure
   (PPViewHashesDontMatch ...)`. V1 and V2 contracts may be on different
   parameterizations of Plutus, and we want each side's tx builder to use the
   cost model that was current when its contract was deployed.

3. **Datum / redeemer encoding.** Cross-version CBOR encoding stability is not
   guaranteed in pre-release mesh builds. Pinning the encoder for each
   contract version keeps the on-chain bytes byte-identical to what callers
   built with the original SDK.

In short: V1 contracts were deployed against mesh `1.9.0-beta.96`/`.90` and V2
against `1.9.0-beta.102`. The two SDK lines must continue to be used in
isolation by their respective code paths.

## Decision

- Files that build, sign, decode, or hash anything related to a **V1** payment
  source — including the shared route code that handles V1 mints — import
  Mesh from the root or `packages/payment-source-v1` versions
  (`@meshsdk/core@1.9.0-beta.96`, `@meshsdk/core-cst@1.9.0-beta.90`).

- Files that do the same for **V2** payment sources import Mesh exclusively
  from `packages/payment-source-v2`'s dependency graph
  (`@meshsdk/core@1.9.0-beta.102`, `@meshsdk/core-cst@1.9.0-beta.102`).

- `packages/payment-core` declares only `@meshsdk/core-cst@1.9.0-beta.90`
  because the helpers it owns (`resolvePaymentKeyHash` in
  `payment-source.ts`, address parsing) are V1-aligned and used from many
  call sites. V2 code that needs the same helper imports it from v2's own
  mesh chain to avoid mixing.

- Do **not** upgrade either pin without an explicit on-chain compatibility
  plan. An upgrade implies a new contract deployment, an update to the
  hardcoded `PAYMENT_SMART_CONTRACT_ADDRESS_*` defaults, and a migration
  story for existing locked funds.

## Consequences

- pnpm hoists both mesh lines into the workspace. The two versions coexist
  in `node_modules/.pnpm/`. Code importing `@meshsdk/core` resolves via the
  nearest `package.json` — V1 packages see `.96`, V2 sees `.102`. This is
  load-bearing; do not flatten with overrides.

- New Mesh-touching code added to the repo must live under the package that
  matches its target payment source type. If it must live in shared `src/`,
  the file is implicitly V1 (because root pins `.96` / `.90`).

- The peer-dependency conflict warning for `@harmoniclabs/crypto` printed by
  `pnpm install` is a consequence of the two coexisting mesh lines and is
  expected.

- Unit-test mocks of `@meshsdk/core-cst` apply globally per Jest test file
  regardless of which mesh version a transitive import would have resolved
  to. Mocks must therefore enumerate the symbols actually imported by code
  under test, not assume only the V1 surface.

## Production bundling (mesh MUST be bundled, not externalized)

The "resolves via the nearest `package.json`" guarantee above only holds while
each module runs from its own package directory — i.e. under `tsx` / `jest` /
`pnpm dev`. The production build (`pnpm build` → `pkgroll`) FLATTENS every
workspace package (`@masumi/payment-source-v2`, etc.) into the root `dist/`
chunks.

`pkgroll` externalizes anything in the root `dependencies` /
`peerDependencies` as a bare specifier. If `@meshsdk/core` /
`@meshsdk/core-cst` are externalized, the flattened bundle emits bare
`import ... from '@meshsdk/core'` for BOTH V1 and V2 code, and at runtime
`node dist/index.js` resolves that single specifier from the ROOT
`node_modules` (the `.96` / `.90` V1 line). The bundled V2 code then silently
runs on the V1 mesh line and derives the WRONG V2 script address in production
— dev/tsx is unaffected, so it passes locally and fails only in prod.

Fix: `@meshsdk/core` + `@meshsdk/core-cst` live in the root
**`devDependencies`**, NOT `dependencies`. pkgroll therefore BUNDLES them, and
rollup resolves each source file's mesh import relative to that file's
location — V1 sources inline `.96` / `.90` (from root `node_modules`), V2
sources inline `.102` (from `packages/payment-source-v2/node_modules`). Both
versions coexist in the bundle; there is no runtime mesh resolution to
collapse. Mesh is pure JS (no WASM/native), so it bundles cleanly.

Rules:

- Do NOT move `@meshsdk/*` back to root `dependencies` — that re-externalizes
  them and reintroduces the V1/V2 collapse in production. See the
  `_meshsdk_devdep_note` in the root `package.json`.
- Verification: a bundled `getPaymentScriptV1(...)` / `getPaymentScriptV2(...)`
  must derive `DEFAULTS.PAYMENT_SMART_CONTRACT_ADDRESS_PREPROD` and
  `DEFAULTS.PAYMENT_SMART_CONTRACT_ADDRESS_V2_PREPROD` respectively. If V2
  derives the V1 address (or vice versa), mesh got externalized/collapsed.

## Notes

- Related: ADR 0004 (per-payment-source-type service trees). The mesh pinning
  rule is the dependency-graph counterpart to the service-tree split.
