# 13. What limits a Hydra head's settleability, and which parts we act on

Date: 2026-08-08

## Status

Accepted.

## Context

A head is only useful if it can be settled. Closing is not the hard part —
fanout is, because fanout has to put every in-head UTxO back on L1 inside
transactions that the L1 ledger will accept. Hydra 2.3 does this in chunks
(`PartialFanoutTx`), binary-searching for the largest chunk that fits.

We drove a two-party head on preprod to `FanoutPossible` and it stopped there
with 232.498 ADA and 28 UTxOs behind the head script. Investigating that gave
us measurements this ADR is built on, and an upstream report (sent).

### What we measured

The chunk the node settled on carries 21 outputs, 20 of them with inline
datums totalling **9,991 serialized bytes** (largest 812, our escrow datums
rest at 771–812). Evaluated with the chain's own evaluator:

|                                           | steps          | against the 10,000,000,000 limit |
| ----------------------------------------- | -------------- | -------------------------------- |
| unbalanced — what the fit check evaluates | 9,996,277,404  | fits, 0.037% spare               |
| balanced — what the wallet then evaluates | 10,058,291,186 | over by 0.583%                   |

Three earlier chunks of the same shape fanned out successfully, each costing
roughly 2.2 ADA in fees from the node's own wallet, never from head value.

### The four distinct limits

They are worth separating, because only one of them is ours to fix.

1. **The fit check evaluates the wrong transaction.** `findFittingFanoutTx`
   chooses a chunk by evaluating it _before_ the wallet adds the fee input and
   change output; `coverFee_` then adds them and the same script exceeds
   `maxTxExUnits`. Balancing costs 62,013,782 steps and the fit check left
   3,722,596. There is no feedback path, so the identical chunk is retried
   forever. **Upstream.**

2. **Chunks are prefixes.** `partialFanout` takes `take chunkSize` over
   TxIn-ordered UTxOs and only the length varies — no offset, no skip. One
   undistributable UTxO therefore blocks everything ordered behind it, and at
   index 0 nothing leaves the head at all. The on-chain side does not require
   this: `FanoutProgressDatum` carries only an accumulator commitment and
   `headAdaOverhead`, with no cursor or count, so arbitrary partitions are
   valid. **Upstream**, and it needs no contract change.

3. **A single output can be individually undistributable.** A chunk cannot be
   smaller than one output. The L2 ledger and L1 share `maxTxSize` 16,384, but
   the fanout transaction's envelope (head input, two reference inputs,
   redeemer, collateral, fee input, change, plus the head continuation output)
   is roughly 840 bytes against roughly 250 for a plain L2 transaction. So a
   resting datum of about 15,544–16,028 bytes is valid on L2 and undistributable
   on L1. Even skipping it does not close this: `finalPartialFanout` requires
   the full set to reconcile, and it is the step that burns the head tokens.
   **Upstream** for the abandonment path; **ours** for not creating such an
   output.

4. **Accumulation costs time and node funds.** Chunking means a large head is
   survivable, not free: every chunk is a separate L1 transaction at roughly
   2.2 ADA. A 200-UTxO head is about ten chunks and a long close-to-`Final`
   cycle. **Ours.**

### What only the resting set matters

Fanout distributes the final snapshot's UTxO set; it does not replay history,
and the accumulator commits to unspent outputs only. An output created with a
large datum and then spent on L2 is never seen by fanout. Only the size an
output comes to **rest** at counts — which is why our 771–812 byte escrow
datums are not at risk, and why an attack requires deliberately parking an
output and leaving it unspent at close.

### What is stranded when settlement fails

The skipped output's own value plus `headAdaOverhead` — hydra's own term for
lovelace in the head UTxO belonging to no L2 UTxO, which a completed fanout
returns to the submitting node as change. So the residue is not only the
counterparty's stake; the overhead was seeded by whoever initialised the head.

## Decision

Document all four limits. Build against none of them.

1. **Accept accumulation cost as expected behaviour.** A large head costs more
   to settle, in proportion to the number of chunks — that is what partial
   fanout is, not a fault. We considered a monitor warning above a chunk
   threshold and rejected it: the cost is predictable from the UTxO count,
   nothing is wrong when it rises, and an alert that fires on normal operation
   trains operators to ignore alerts. It is an operational cost, not a safety
   one, because chunking handles size.

2. **Do not cap per-output datum size in code.** Our resting datums are 771–812
   bytes against a limit near 15,500. A cap would guard a distance of twenty
   times, and the guard would be a constant we would have to keep correct
   against a boundary we have not measured precisely (we have one data point
   and cannot separate fixed proof cost from per-output and per-byte cost).
   Revisit if our datum shape grows materially, or if the slope is ever
   measured.

3. **Do not build an operator retire path yet.** A head that cannot reach
   `Final` blocks its relation permanently: `head/create-head.ts` rejects any new
   head while a non-`Final` one exists, `deletion-guard.ts` requires a
   `fanoutTxHash` verified on chain that such a head does not have, and the
   `acknowledgeActiveEscrows` escape hatch in `head/settlement.ts` is gated on
   `status === Open`. Direct database intervention is currently the only
   remedy, and we used it once. The shape when we build it: an admin endpoint
   named for what the operator accepts, retiring the head record to free the
   relation while persisting `headIdentifier`, the remaining UTxO set and the
   reason, so a later recovery has what it needs.

4. **Nothing upstream is worked around in our code.** Limits 1–3 are reported
   upstream with evidence and proof scripts. A patched hydra release fixes
   future heads only — an already-stuck head is locked to the deployed script
   hash, and only a protocol parameter change (`maxTxSize`,
   `maxTxExecutionUnits`, or a cheaper cost model) could ever free it.

## Consequences

- A head that grows large stays settleable, but settling it is slow and costs
  node wallet funds proportional to the number of chunks. Nothing warns about
  this, by choice. Roughly: one chunk per 20 in-head UTxOs, about 2.2 ADA each,
  paid from the node's own wallet in one burst at close. An operator closing a
  large head should check the node wallet against that estimate first.
- We remain exposed to limit 3 by construction. It requires a counterparty to
  deliberately park an output with a very large resting datum, costs them its
  min-UTxO (roughly 67 ADA at 15.5 KB, at `utxoCostPerByte` 4310), and gains
  them nothing but denial. We accept that rather than carry a guard constant we
  cannot yet site correctly.
- The one mitigation that exists is pre-close: before close the UTxO set can
  still be changed by spending the offending output on L2; after close nothing
  about it can change. We do not implement detection for this today, which
  means in practice the mitigation is unavailable.
- If a head does become unsettleable, its relation is dead until someone edits
  the database. That is a known, accepted operational gap, not an oversight.
- `docs/adr/0005-meshsdk-version-pinning-v1-v2.md` governs why the head's cost
  models must match the pinned mesh line; `src/lib/hydra/hydra/params-drift.ts`
  now checks the running head against the ledger we ship, including `maxTxSize`
  and execution units, because a head whose L2 `maxTxSize` exceeds L1's is how
  limit 3 becomes reachable by accident rather than by attack.
