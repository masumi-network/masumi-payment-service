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
   forever. **Upstream.** _Still true in 2.4.1:_ `fitsTx` checks the built
   transaction and `finalizeTx` balances it afterwards
   (`Chain/Direct/Handlers.hs:211-257`).

2. **Chunks are prefixes.** In hydra-node 2.3, `partialFanout` takes
   `take chunkSize` over TxIn-ordered UTxOs and only the length varies — no
   offset, no skip. One undistributable UTxO therefore blocks everything
   ordered behind it, and at index 0 nothing leaves the head at all. The
   on-chain side does not require this: `FanoutProgressDatum` carries only an
   accumulator commitment and `headAdaOverhead`, with no cursor or count, so
   arbitrary partitions are valid. **Upstream**, and it needs no contract
   change.

   _Corrected 2026-10-21 for hydra-node 2.4.1, which this service now pins:_
   the paragraph above is stale. 2.4.1 adds a client-driven `PartialFanout
{utxoToFanout}` command (`hydra-node/src/Hydra/API/ClientInput.hs:22`).
   The node accepts any non-empty sub-multiset of the remaining outputs
   (`HeadLogic.hs:1493-1531`), so healthy outputs can leave the head even when
   a bad output sorts before them. Inside one selection the node still chunks
   by prefix (`take chunkSize`, `Chain/Direct/State.hs:669`). A bad output
   therefore blocks only the selection that contains it. The earlier text
   described 2.3 correctly; it went stale when the pin moved to 2.4.1 and the
   ADR was not reviewed with it.

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

   _Still true in 2.4.1 (checked 2026-10-21):_ `finalPartialFanout`
   (`Chain/Direct/State.hs:684`) must distribute every remaining output, and
   it is the only step that burns the head tokens. A selection never removes
   the bad output, so the head can drain everything else and still never
   reach `Final`. The relation stays blocked (see decision 3). The size at
   which one output stops fitting is not measured for 2.4.1; the
   15,544 to 16,028 byte range above is an estimate from 2.3 envelope sizes.

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

2. **Cap output size through the L2 ledger, not in code.** _Revised
   2026-10-21; the original decision follows._ The shipped L2 ledger now uses
   `maxTxSize` 15,000. An L2 tx can then create no output larger than that, and
   the 2.4.1 fanout envelope measured at 917 bytes
   (`docs/hydra-fanout-output-size-measurement.md`) keeps every such output
   under L1's 16,384. The node itself enforces the limit on every L2 tx it
   validates, so a hostile peer cannot park an oversized output in a snapshot
   our node signs. A deposit cannot bring one in either: the measured deposit
   limit (datum about 15,266 bytes) is below the fanout limit (15,421).
   `ledger-params.spec.ts` and `params-drift.ts` both hold the value.

   _Original decision, superseded:_ do not cap per-output datum size in code.
   Our resting datums are 771 to 812 bytes against a limit near 15,500. A cap
   would guard a distance of twenty times, and the guard would be a constant
   we would have to keep correct against a boundary we have not measured
   precisely. It was wrong in one respect: the guard needed no constant in our
   code, because the L2 ledger already has one. The boundary is now measured.

3. **Give operators a retire path.** _Revised 2026-10-21; the original
   decision follows._ `POST /hydra/head/retire` (`head/retire.ts`) retires a
   head that cannot reach `Final` and frees its relation for a new head. It
   moves no funds. The caller must send `acknowledgeStrandedFunds: true` and a
   reason. The endpoint accepts a `FanoutPossible` head, or a `Closed` head
   after its stored contestation deadline (a `Closed` head with no stored
   deadline is refused), and only when the independent L1 observer
   shows the head closed. It disables the head and stores `retiredAt`, the
   reason, the remaining UTxO set from the node and the L1 tx that holds the
   head output. It keeps `headIdentifier` and whatever init anchors the head
   still has, because a later recovery restarts a node from them. Retire does
   not check that the anchors exist: a head that was disabled before may have
   lost them. Retire bumps `ownerEpoch`, so the old session cannot write to the
   record, and enable, disable and the status fail-closed path all skip a
   retired head. Before the write it refuses when the node reports a later
   status than the database, and it reads L1 a second time and requires the
   same head output tx. A fanout that is posted but not yet on L1 stays
   invisible to both checks, so an operator must not retire a head while a
   fanout is in flight. The contestation guard reads the stored
   `contestationDeadline`, which is written once at close and does not move
   when a contest extends the deadline. The L1 observer reads Close and
   Contest both as `closed`. So retire can pass while a contest is still
   running. The hydra-node process contests on its own and retire does not
   stop it, so we accept this. The one-live-head index
   (`HydraHead_one_live_per_relation_key`) leaves retired heads out. A retired
   head still blocks deletion of its relation, participants and host, and the
   requests bound to it stay unsettled: their funds are on L1 behind the head
   script, and nothing here can prove where they go next.

   Before retiring, an operator can move every output that fits out of the
   head with `POST /hydra/head/partial-fanout` (`head/partial-fanout.ts`). It
   sends hydra-node 2.4.1 a `PartialFanout` with the chosen in-head
   references. After the first step the head is `FanningOut` (a status ranked
   between `FanoutPossible` and `Final`) and hydra-node refuses a plain
   `Fanout`. Every selection is built from the node's own head state
   (`GET /head`, parsed in `fanout-head-state.ts`), the set the node checks
   a selection against. `GET /snapshot/utxo` is not that set: it adds a
   pending commit the node may not fan out, leaves out a pending decommit the
   node does fan out, and keeps the confirmed snapshot after the first step.
   The endpoint and retire refuse while the node fans out on its own
   (`AutoDrain` or `DistributingSelection`): a new selection would replace the
   one in progress. Retire accepts a `FanningOut` head too and stores the
   remaining set.

   _Original decision, superseded:_ do not build an operator retire path yet. A head that cannot reach
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
- _Superseded 2026-10-21 by revised decision 2:_ a head that runs the shipped
  L2 ledger cannot hold an output that fanout cannot move. A head started
  before the change still runs `maxTxSize` 16,384 and stays exposed;
  `params-drift.ts` reports it. Restart a node on the new params only between
  heads. INFERRED, not tested: a node mid-head on a smaller limit rejects a
  peer tx above 15,000 bytes, and that tx's snapshot then stalls. The V2
  builders cap their unsigned txs at 14,000 bytes (`MAX_SAFE_TX_BYTES`).
- _Original consequence, kept for the record:_ we remain exposed to limit 3
  by construction. It requires a counterparty to
  deliberately park an output with a very large resting datum, costs them its
  min-UTxO (roughly 67 ADA at 15.5 KB, at `utxoCostPerByte` 4310), and gains
  them nothing but denial. We accept that rather than carry a guard constant we
  cannot yet site correctly.
- The one mitigation that exists is pre-close: before close the UTxO set can
  still be changed by spending the offending output on L2; after close nothing
  about it can change. We do not implement detection for this today, which
  means in practice the mitigation is unavailable.
- _Superseded 2026-10-21 by revised decision 3:_ an unsettleable head no
  longer kills its relation. An operator retires it and opens a new head. The
  funds left in the retired head stay stranded until the protocol frees them.
- _Original consequence, kept for the record:_ if a head does become
  unsettleable, its relation is dead until someone edits the database. That is
  a known, accepted operational gap, not an oversight.
- `docs/adr/0005-meshsdk-version-pinning-v1-v2.md` governs why the head's cost
  models must match the pinned mesh line; `src/lib/hydra/hydra/params-drift.ts`
  now checks the running head against the ledger we ship, including `maxTxSize`
  and execution units, because a head whose L2 `maxTxSize` exceeds L1's is how
  limit 3 becomes reachable by accident rather than by attack.
