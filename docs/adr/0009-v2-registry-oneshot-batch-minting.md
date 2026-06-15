# ADR 0009 — V2 registry oneshot batch minting (one UTxO seeds a batch)

## Status

Accepted.

## Context

The V2 registry minting policy
(`smart-contracts/registry-v2/validators/mint.ak`) derives each asset name as:

```text
asset_name = nonce (1 byte) ++ root_hash (28 bytes) ++ version (3 bytes)
           = nonce ++ blake2b_224(input.tx_id ++ input.output_index_be4) ++ 0x000000
```

The `MintAction` validator checks, for every minted asset, only that the
asset's 28-byte `root_hash` matches the hash of **some** spent transaction
input — it does **not** constrain the 1-byte `nonce`, and it does **not**
require distinct inputs per asset:

```aiken
let root_hash_comes_from_spent_input =
  list.has(input_root_hashes, asset_root_hash)
// ...no list.unique(asset_root_hashes) constraint
```

This is the **oneshot rule**, stated outright in
`smart-contracts/registry-v2/README.md`:

> `nonce` … lets one consumed input authorize multiple mints in the same
> transaction.

So **one** consumed wallet UTxO can authorize an entire batch of agent
registrations in a single transaction: every minted asset shares the same
`root_hash` (from the one shared `firstUtxo`) and is made unique by a distinct
`nonce` (`0x10`, `0x11`, …). The usable nonce range is `0x10..0xff` (the
`> 0x0f` guard keeps registry names out of the CIP-67/CIP-68 label space),
giving **240 mints per UTxO**.

### The regression this ADR prevents

An earlier off-chain implementation hardcoded `nonce = 0x10` in
`generateRegistryAssetNameV2` and therefore could not produce two distinct
names from one UTxO. To compensate, the batch register services assigned one
**distinct wallet UTxO per agent** positionally
(`const utxo = spendableUtxos[idx]`). When a wallet had fewer UTxOs than the
number of queued agents in a batch, the tail items hit:

```text
Error: Insufficient wallet UTXOs to assign a distinct firstUtxo to this request
```

Worse, the failure was a **synchronous `throw` inside `Array.map`**, which
escaped `Promise.allSettled` before it could wrap the rejection, bubbling to
the outer batch-fallback catch and aborting the **entire** batch every
scheduler tick — even the items that did have a UTxO never progressed. The
wallet looped lock → throw → unlock → retry indefinitely until it organically
accumulated enough UTxOs to cover the whole batch at once. (Observed in
production for wallet `cmq7uqazo…` on 2026-06-10.)

This was a self-inflicted constraint: the contract never required one UTxO per
agent. The off-chain code was stricter than the on-chain rule.

## Decision

Off-chain registry batch minting MUST follow the contract's oneshot rule:
**one shared `firstUtxo` seeds the whole batch; each item gets a distinct
`nonce`.** A registry batch must NOT require one wallet UTxO per agent.

Concretely:

1. `generateRegistryAssetNameV2(firstUtxo, nonce = '10')` takes a `nonce`
   parameter. The pure naming logic lives in
   `src/services/registry/asset-name.ts` (no Mesh SDK dependency, so it is
   unit-testable without libsodium WASM init). `shared.ts` re-exports it to
   keep the `@/services/registry/shared` import surface stable.

2. `registryNonceForIndex(idx)` maps a 0-based batch index to its nonce byte
   (`0 → '10'`, `1 → '11'`, … `239 → 'ff'`) and throws past the 240-mint
   ceiling (`V2_REGISTRY_MAX_MINTS_PER_UTXO`).

3. Both batch register services
   (`packages/payment-source-v2/src/services/registry/register/service.ts`
   and `.../registry-inbox/register/service.ts`) pick a single
   `sharedFirstUtxo = sortUtxosByLovelaceDesc(utxos)[0]` and hand every item
   `registryNonceForIndex(idx)`. The positional `spendableUtxos[idx]`
   per-agent-UTxO requirement is removed.

4. The validation map callback is `async`, so any genuine per-item validation
   throw (pricing, asset-name shape) settles as a `rejected` outcome handled
   per-request via `markRequestFailed` — it can no longer escape
   `Promise.allSettled` and abort the batch.

5. A batch larger than 240 is capped per tick; the overflow stays in
   `RegistrationRequested` for the next tick. `REGISTRY_BATCH_SIZE` is 7, so
   this guard never triggers in practice — it exists so an oversized batch can
   never silently produce a colliding nonce.

### Collateral interaction

The shared `firstUtxo` may double as the collateral UTxO. Conway phase-1 does
not forbid the collateral UTxO from also appearing in the (non-script) spending
input set, and the batch mint builder de-dupes identical `firstUtxo` refs down
to a single `txIn`. Therefore a wallet holding **a single pure-ADA UTxO of
≥ 5 ADA** can register a full batch — it serves as both `firstUtxo` (for all
items) and collateral. This is strictly weaker than the
`ensureCollateralReady` ≥ 2-UTxO invariant for script-spending actions
(ADR-0007); registry mints are not script-spends, so the readiness helper's
fee-input concern is covered by Mesh's coin selector picking remaining wallet
UTxOs for fees + change.

## Why uniqueness still holds

- Within a batch: each item has a distinct `nonce`, so all asset names differ
  even though they share a `root_hash`. The mint contract's
  `quantity == 1`-per-asset rule is satisfied.
- Across batches: the shared `firstUtxo` is **consumed** by the mint tx, so it
  cannot seed a future batch — no cross-batch `(root_hash, nonce)` collision is
  possible. If a tx fails to submit, the UTxO is not consumed and the next tick
  re-derives the same names, but since nothing was minted there is no on-chain
  collision.
- `agentIdentifier = policyId + assetName` is computed pre-mint and persisted
  post-submit; tx-sync, update (`bumpRegistryAssetNameVersionV2` preserves the
  nonce), and deregister all operate on the stored value, so varying the nonce
  per item does not affect any downstream consumer.

## Consequences

- A wallet no longer needs one UTxO per queued agent. The "Insufficient wallet
  UTXOs" abort-the-whole-batch loop is eliminated.
- The single-item fallback paths keep the default `nonce = 0x10` — each single
  tx consumes its own `firstUtxo`, so no collision and no behavior change.
- The naming logic is now covered by `src/services/registry/asset-name.test.ts`,
  including an explicit **oneshot batch invariant** test: one shared UTxO →
  N distinct, valid asset names sharing one root. If anyone reintroduces a
  per-agent-UTxO requirement, that test must be changed to do so — making the
  regression visible in review.

## Related

- ADR-0006 — shared `Transaction` row for V2 batches (how the batch tx hash is
  persisted across all participating requests).
- ADR-0007 — V2 collateral-readiness invariant (the ≥ 2-UTxO rule for
  script-spending actions; registry mints are exempt as described above).
