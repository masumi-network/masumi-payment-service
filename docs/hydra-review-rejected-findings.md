# Hydra PR review: findings that were checked and rejected

PR [#581](https://github.com/masumi-network/masumi-payment-service/pull/581) has been
reviewed in rounds, each by reviewers who had not seen the earlier ones. That is
deliberate — a fresh reader finds what a familiar one stops seeing — but it also
means the same wrong finding arrives more than once.

This file is the answer to those. Each entry is a claim that was raised, checked
against the code, and found not to be a defect, with the evidence that settled it.
A reviewer who is about to report something listed here should read the entry
first: if the reasoning still holds, the finding is answered; if the code has moved
underneath it, say so explicitly rather than re-filing the original claim.

Confirmed findings are not recorded here. Those became commits.

<!-- Entries: newest first. Keep the shape: claim, where, why it is not a defect. -->

## Round 6

Every finding this round survived checking and became a commit. The entries
below are corrections, not rejections: both amend a round-5 fix, and a reviewer
reading the round-5 note without this one will re-derive a claim that has
already moved on.

### `mergeMultisets` should take the larger of the two removal allowances (superseded)

**Status.** The round-5 answer below still stands as far as it goes — the
maximum was wrong, and the partitions are disjoint by reference — but summing
value multisets was not enough, and the function it names no longer exists.

**What was still wrong.** Disjointness proves the two outputs _exist_, not that
both _left_. Every allowance was derived from value multisets, which cannot tell
one pending output from another of the same size, and three separate holes
followed. A deposit that was ABSORBED — the normal ending — still counted as
recoverable, so an in-head output of that value could vanish with no
transaction. A deposit still pending in both snapshots was granted injection
slack on every transition it survived, so an output of its value could appear
from nowhere. And an ordinary spend of any same-valued in-head UTxO cancelled a
real deposit's recovery allowance, rejecting a legitimate transition — the same
permanent-wedge failure the round-5 entry describes, reintroduced through a
different door.

**Where it landed.** `VerifiedHydraSnapshot` now carries `committedOutputs` and
`decommitOutputs` keyed by reference, like `outputs`, and
`doesHydraTransactionTransitionReachSnapshot` derives both allowances by
reference before counting them by value: a deposit is an injection only on the
snapshot that first declares it, and a pending entry is a removal only when its
reference is absent from `current.outputs` and no transaction spent it. Summing
is then correct because the references are distinct. Pinned by three tests, each
verified to fail against the old logic.

### The Hydra hot-wallet hold is safe because nothing else clears `lockedAt`

**Status.** Wrong, and the round-5 commit that introduced the hold said so in
its own docblock. `unlockStaleOrphanWalletLocks` frees any wallet with no
pending transaction after `CONFIG.WALLET_LOCK_TIMEOUT_INTERVAL` (300s), which is
exactly the shape `claimHotWalletForL1` produces — and a carve waits up to five
minutes for its own confirmation. The safety net was handing the wallet to a
batcher mid-carve.

**Where it landed.** `HotWallet.lockPurpose` marks a lock that is not a
batcher's; both reapers skip those, and a second pass frees them on
`HOT_WALLET_LOCK_STALE_AFTER_MS` (30 minutes) instead.

## Round 5

Every finding this round survived checking and became a commit, including one
that reproduced as a production deploy failure. Two entries below are not
rejected findings but corrections that will read like defects to the next
reviewer.

### `mergeMultisets` should take the larger of the two removal allowances

**Claim.** A pending decommit and a pending deposit can be the same output, so
summing `previous.decommitMultiset` and `recoverableCommits` would authorise
twice the value actually pending.

**Why the maximum was wrong.** `canonicalSnapshotOutputs`
([snapshot-verification.ts](../src/lib/hydra/hydra/snapshot-verification.ts))
throws when one output _reference_ appears in two partitions, so the partitions
are disjoint by construction. The multisets are keyed by serialized value, not
reference, so a shared key means two different outputs whose bytes match — the
ordinary shape of a pure-ADA withdrawal and a pure-ADA top-up of the same size
to the same wallet. The allowance really is two. The maximum under-counted the
transition where both left at once, the conservation walk failed, and because
history replays from the beginning on every reconnect that frame rejected
forever: no verified session, and every L2 escrow operation on that head failing
closed. It is a sum now, pinned by "lets a decommit and a recovered deposit of
the same value leave together".

### `carveExactUtxo` should reuse a matching UTxO for token top-ups too

**Claim.** The reuse that stops a retry carving a second UTxO is applied only to
lovelace; a token top-up should get it as well.

**Why it is not a defect.** For ADA the match is total: a pure-lovelace UTxO of
exactly the amount holds that and nothing else, so committing it is exactly what
was asked for. A token UTxO also carries lovelace, and how much is the wallet's
history rather than this call's choice — a UTxO holding exactly 750 USDM may sit
on 200 ADA, and Hydra commits whole UTxOs, so reusing it would lock that ADA in
the head until it closes. A carve pays the ledger minimum, so for a token the
second carve is the cheaper mistake. `isCarveOf` additionally refuses any UTxO
carrying a third asset, which is what keeps an agent's registry NFT out of a
head.

## Round 4

### The L2 stand-down should write the cooldown columns

**Claim.** When an L2 pass defers a request (the head is not usable yet), it should push
`sellerCoolDownTime` / `buyerCoolDownTime` into the future so the next batch skips it,
the way the L1 paths space out their retries.

**Why it is a defect to do so.** Those two columns are not scheduler state. They are a
mirror of the on-chain datum: `hydra-datum-sync` writes them from `decoded.sellerCooldownTime`
/ `decoded.buyerCooldownTime`, and `continuationHasAuthorizedActor` in
`src/utils/logic/hydra-datum-guards` reads them back as `startsAfter(request.sellerCoolDownTime)`
against the signed body's `invalid_before`. A fabricated future value makes that guard
unsatisfiable, `applyDatumStateToLocalRequests` returns `'retry'` forever, the head is
marked stalled by `markReconciliationStalled`, and replay wedges for _every_ request on it —
not only the deferred one.

This was written and shipped in round 3, and caught in round 4. The replacement is
`packages/payment-source-v2/src/services/l2-queue-rotation.ts`: an in-memory set of deferred
request ids with a one-minute cooldown, passed to `lockAndQueryPayments` /
`lockAndQueryPurchases` as `excludeRequestIds`. It rotates the queue without touching a
single column the chain owns. Do not re-suggest the column write.

### A decommit transition should carry its transaction on every step

**Claim.** `transition-shapes.spec.ts` passes `[]` for the transactions of a transition
that finalises a decommit, so the replay must be dropping it.

**Why it is not a defect.** A decommit's transaction is supplied on the transition that
first _declares_ it, not on the later ones that carry it to finality. See the round-3 entry
below, which this repeats.

## Round 3

Every finding this round survived checking and became a commit. The one entry
below is not a rejected finding but a correction that will read like a defect to
the next reviewer.

### A decommit that stays in `utxoToDecommit` is dropped from the later transition

**Claim.** `resolveNewlyDeclaredDecommitTransactions`
([decommit-resolution.ts](../src/lib/hydra/hydra/decommit-resolution.ts)) only returns a
decommit's transaction on the transition where its reference first appears, so a
head that reports the same pending decommit in three consecutive snapshots
supplies the transaction once and omits it twice. The two omissions look like
lost transactions.

**Why it is not a defect.** The conservation walk in
[node-history-replay.ts](../src/lib/hydra/hydra/node-history-replay.ts) checks that a
transition's transactions account for the difference between two snapshots.
`previous.outputs` is the _canonical_ output set and spans all three partitions —
`utxo`, `utxoToCommit` and `utxoToDecommit` (see `canonicalSnapshotOutputs`) — so
once a decommit has been declared, the outputs it removes are already on the
previous side of every later comparison. Supplying its transaction again would
subtract them a second time and fail the walk. Declaring it exactly once, on the
transition that first announces it, is what balances.

This also settles the argument that used to be flagged in
`transition-shapes.spec.ts`: passing `[]` for an already-declared decommit is the
correct expectation, not a stub, because that is what the production caller
passes on the second and third sightings.

## Round 2

### The initial L2 lock should release its reservation on a transport error

**Claim.** `executeReservedL2Submission` now rolls back when the command never reached the
socket (`HydraTransportError`), so `l2-lock-execute.ts` should do the same for the initial
funds lock — otherwise a provider swapped out mid-submit strands that reservation.

**Why it is not a defect.** The initial lock is deliberately fail-closed, and the file says
why: its reservation is the only thing standing between a retry and a _second_ lock built
from different wallet inputs. The six non-locking actions can be rolled back because every
retry of one spends the same unique prior script UTxO — the lock has no such invariant.
Rolling it back on a transport error would trade a stuck reservation, which an operator can
see and reconciliation can settle, for the possibility of locking the same funds twice.

The half of the finding that was real is fixed: the six non-locking actions no longer treat
a never-dispatched command as ambiguous, because nothing reconciles a transaction that does
not exist.

### `HydraProtocolError` should also roll back a reservation

**Claim.** Like `HydraTransportError`, a protocol error is raised before bytes reach the
socket, so it should permit rollback too.

**Why it is not a defect.** Only _some_ protocol errors are pre-dispatch. The command
channel converts a malformed response into `HydraTransportAmbiguousError` once `wasQueued`
is set, but `HydraProtocolError` is also raised from frame validation and from the provider
on paths that are not reachable only before dispatch. `HydraTransportError` carries the
guarantee in its own contract — it is constructed exclusively on the `!wasQueued` branches —
and that guarantee is what makes rollback safe. Widening the rule to a class that does not
carry it would roll back reservations for transactions that may well have been submitted.

## Round 1

### The pre-submit nudge should be a compare-and-swap on `currentTransactionId`

**Claim.** `packages/payment-source-v2/src/services/purchases/batch-payments` writes the
intended transaction hash onto the request before submitting, and the `where` of that
update matches on `id` and `nextActionId` only. It should also require
`currentTransactionId: null`, or a concurrent writer can overwrite a transaction that is
already in flight.

**Why it is not a defect.** The update is written to run against a request that already
has a `CurrentTransaction`: it connects the previous one into `TransactionHistory` in the
same statement. Requiring `currentTransactionId: null` would make the update match nothing
on every request that has ever submitted a transaction — which is every retry, every
resubmission after a rollback, and every request past its first action. The exclusion this
finding wants already exists and is not in the `where`: the batch holds the per-payment-source
mutex for the whole build-and-submit, and `nextActionId` in the `where` is itself the fence
against a second writer that has moved the action on.

Half of the original finding _was_ real and was fixed: the hash is now written before
submission rather than after, so a process that dies between submit and update leaves a
recoverable record rather than an orphan transaction.

### `HydraNode` / `HydraConnectionManager` exceed the 750-line ceiling

**Claim.** Two files are over the repository's hard file-length limit.

**Why it is not a defect _now_.** They were, and they were split — see ADR 0014 and the
registry / `HeadSession` / collaborator decomposition. A reviewer measuring the files as
they stand on `gd/impl-hydra` will find them under the ceiling. Re-file only with the
current line count in hand.

## Round 7

**"The port table wrongly marks the peer range exposed."** Half right, and the
half that was wrong is the important one. `5001-5032` genuinely does have to be
reachable — a head whose peer port is closed cannot reach its counterparty — so
"exposed" is not the error. What the table left out is that the base compose
file deliberately does _not_ publish it: the range is unauthenticated etcd raft,
and it only comes up through `docker-compose.public-peer.yml` after the
generated nftables ruleset has been applied. The row now says so.

**"Two `initialDelayMs` collisions"** — there were six. Four belong to this PR's
Hydra jobs and are re-staggered; `55000` and `60000` are a pre-existing pair on
the fund-transfer jobs and are left alone, being neither Hydra nor in this PR's
diff.

**"Six unregistered Hydra endpoints in `docs.ts`"** — seven. `init`, `close`
and `fanout` look unregistered to a naive grep because they are registered from
a `for` loop over a template literal; the genuinely missing ones were
`GET /hydra/head/topup`, `POST /hydra/head/topup/recover`,
`GET /hydra/head/connection`, `DELETE /hydra/head/errors`,
`GET`/`POST /hydra/participant/local/fund` and
`POST /hydra/participant/local/withdraw`.

**Corrections to earlier rounds' own fixes.** Round 6 claimed "both reapers skip
a purposed lock". There were three, and the third — `timedOutLockedHotWallets`
in `wallet-timeouts/service.ts` — was unguarded, so the Hydra L1 hold was still
freed at 300s. Six further relation-driven lock clears in the same file had the
same hole. Round 6 also rewrote `doesHydraTransactionTransitionReachSnapshot`
around reference-derived allowances and left the solver picking a single point
on an equation with a free variable per value; the round-7 fix replaces that
with an interval and makes an authenticated removal mandatory rather than
optional. The interval solver was checked against a brute-force feasibility
oracle over 9,437,184 two-value cases with zero disagreements.

## Round 8

**"Relaxing the first-anchor check so a head can open with funds"** — not
changed. `node-history-replay` adopts the first signed snapshot without checking
it, which is only sound because it cannot have moved value: every head this
service opens opens empty, since `validateHydraCommitDraft` requires the
deposit-script output shape that hydra-node produces only for an Open head, so
an initial commit is never signed. Adopting a snapshot that _does_ carry
transactions would mean trusting an unverified `confirmed` list, which is a
larger change than the reachable problem warrants. What was actually wrong was
`docs/hydra-architecture.md`, which advertised initial commits as supported;
that claim is corrected and the constraint is now stated at the throw site.

**"The strict output schema is fail-closed, so leave it"** — rejected. It is
fail-closed in the worst possible place: history replays from the beginning on
every reconnect, so one rejected frame is rejected forever, and a head with no
verified session has no clock and fails every L2 escrow operation. Strictness
bought nothing the accumulator does not already enforce — a field that changes
an output's serialized bytes fails the commitment check either way, and one that
does not is cosmetic — so `hydraSnapshotOutputSchema` and
`hydraReferenceScriptSchema` are now loose, with the added keys reported through
`detectSnapshotDrift` instead. Renames are still caught: the modelled fields stay
required.

**Corrections to earlier rounds' own fixes.** Round 7 added
`assertNoUnrecoveredHydraDeposits` to two of the three participant-delete paths;
the remote path had it added in round 8, with a test that fails without it.
Round 7's `docs.ts` registration put `close` in a loop with `init` and `fanout`
even though it takes a different input schema, and described both DELETE bodies
as query parameters — `src/app.ts` overrides the DELETE input sources to
`['body', 'params']`, so a query would never have been read. Round 7's own
`HydraNodeDetailsDialog` copy claimed the Edit dialog can change a node's URL; it
cannot, and the copy said so only because I wrote it that way.

**Round 7's snapshot solver, independently re-checked.** A fresh reviewer
rebuilt the feasibility oracle from scratch and ran 29,700 two-value cases
through the real function with real CBOR snapshots (0 disagreements), plus 400
randomized head traces of 25 steps each — 10,000 legitimate transitions covering
deposits declared, re-declared, absorbed and recovered, decommits declared,
pending and settled, and a decommit spending a deposit absorbed in the same
step — with zero false rejections. The negative control rejected 5,080 of 7,381
single-transaction drops; the remainder are genuinely value-neutral over a
three-value pool. Making the removal FIXED rather than an upper bound is
load-bearing: with an optional removal, a value in `previous.decommitOutputs`
reappearing in `current` admits `consumed = 0`, which is value appearing from
nowhere.

**Reference-level forgery, again.** Raised and again not filed. The accumulator
commits to serialized outputs only, so an endpoint permuting which reference
carries which value across partitions is invisible to it. That is a property of
the commitment, is stated in the function's own docblock and in ADR 0012, and is
gated on `trustLocalNodeSnapshotMetadata` — not a regression, and not fixable
without a different commitment.

**"The decommit stale-claim can double-withdraw"** — could not be constructed.
Once a decommit is approved its outputs leave the `utxo` partition that
`snapshotUTxO()` returns, so a second withdrawal cannot select them; while it is
still pending the node refuses a second decommit and the settle path marks the
new row Failed. Round 7's `PENDING_STALE_AFTER_MS` stands.

## Round 9

**"`remove()` can delete a live wedged node's persistence directory"** — not
changed. The path is real: `stop()` returns true from its "genuinely down"
branch, and `remove()`'s guard is `!stopped || isResponsive()`, so a node that
is alive but invisible to both the pid check and its own API would pass. But
that is the definition of having no evidence the node exists — the process scan
cannot see it and it does not answer — and the alternative is refusing removals
for nodes that really are gone, which is the case an operator actually hits.
In-container the children die with PID 1, so this is a native-mode-only corner.
Recorded rather than fixed.

**"SIGTERM during `boot()` is deferred with no bound"** — half accepted. The
deferral itself is right: dying instantly there orphans whatever `boot` has
already adopted or spawned, holding peer ports past the only process that could
drain them. What was wrong was that nothing acted on the signal until boot had
finished, which at 32 records is minutes of a platform waiting out its stop
grace. `Supervisor.beginShutdown()` now exists and `boot` returns at the next
record when it is set. The servers still bind if a signal arrives late in
startup; the replay closes them within milliseconds of the handlers going in,
which is not worth restructuring the startup order for.

**Corrections to round 8's own fixes.** Two of the three hydra-host fixes were
incomplete, and a fresh reviewer measured both:

- `shutdown()` was un-serialised from the in-flight tick but still SKIPPED any
  node the tick held, deferring it to the pass after `await pendingTick`. That
  kept the two passes additive for every tick action that is not itself a stop —
  an observe, an unwedge, or a worker that returned early on `stopped` while a
  sibling kept the tick alive. Measured at 4985 ms against a 2000 ms per-node
  drain budget, which at the real budget is 310s against a 240s guard. It now
  waits the hold out instead, which costs only the hold.
- Honouring `restartRequested` for a not-responsive node was right, but `start()`
  never cleared the flag, so a restart requested on a STOPPED node fired again
  15s into the boot it had just caused: SIGTERM to a node that was still bringing
  etcd to quorum, returned as `lastStopUndrained` having never been wedged. The
  start now answers the request, which also removes the pre-existing redundant
  restart of a healthy node.

**The commit endpoint accepted `Initializing`, and the UI offered it.** Not a
doc bug — `carveExactUtxo` submits a real L1 transaction before
`buildValidatedHydraCommit` is ever called, and an initial commit fails that
validation twice over (it pays the head script, not the deposit script, and
carries a `script_data_hash` from the vInitial redeemer). So the operator paid a
fee for a request that could not succeed, and the handler then held their hot
wallet for the full stale-lock window because the carve was unsettled. The
endpoint is Open-only now, the button is gated to match, and the lifecycle
diagram — which still showed a commit self-loop on Initializing, contradicting
the prose fifteen lines below it — was corrected with it.
