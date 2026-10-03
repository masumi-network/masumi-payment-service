# L2 ledger protocol parameters

These files are **generated**, not hand-edited. Regenerate with:

```bash
pnpm --filter @masumi/payment-source-v2 run generate:hydra-params
```

## Why the generator lives in `payment-source-v2`

The head's ledger must use the same Plutus cost models as the transactions the
payment service builds against it. If they diverge, every in-head script spend
fails `PPViewHashesDontMatch`, and it fails at commit time — far from the cause.

The V2 mesh line is pinned by `packages/payment-source-v2`, so importing
`@meshsdk/core` from there resolves to exactly the models the V2 builders use.
The same import from the repo root would resolve to the V1 line and silently
produce the wrong file. The pin has one home and the params follow it.

## Layout

- `base/<network>.json` — the L2 ledger policy: everything except cost models.
  Hand-maintained and reviewed. Fees are zero, because a head charges nothing.
- `<network>.json` — generated: the base plus the pinned mesh cost models.
  This is what ships in the image and what `--ledger-protocol-parameters`
  points at.

## Adding a network

A network is generated only if it has a base file, and that is deliberate.
Shipping preprod-derived values — `utxoCostPerByte`, `protocolVersion`,
deposits — as another network's params would configure a head with the wrong
ledger; on mainnet that head holds real funds.

**Mainnet has no base file yet.** Adding one means taking mainnet's current
protocol parameters, zeroing the fee fields, dropping `costModels`, and
reviewing the result. The Host refuses to start if the file for its configured
network is missing, so this fails loudly rather than silently.

## Drift

CI runs the generator with `--check`. It fails when the committed files no
longer match the pinned mesh version, which is the signal that a mesh bump also
needs a params regeneration — and, per
`docs/adr/0005-meshsdk-version-pinning-v1-v2.md`, an on-chain compatibility
plan.
