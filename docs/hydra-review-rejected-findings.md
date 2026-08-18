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

## Round 9b

**"Two releasers race on the same hot wallet lock."** Refuted as a lock bug,
accepted as an attribution bug. `hydra-topup-reconciliation` and
`hydra-topup/execute` both call `releaseHotWalletAfterL1` for the same wallet,
but the release is idempotent and neither leaves the wallet unlocked while work
is outstanding — the wallet is genuinely free once the L1 deposit confirms. What
is real is _which_ operation the release is attributed to: the commit display row
carries `commitTxHash === depositTxHash`, so the reconciler treated the commit's
own transaction as a topup deposit and released a lock the commit path was still
holding. Fixed by skipping the release for that row in both the pending and the
recovered path, and by making `execute.ts` release only once the carve is
actually confirmed.

**The general attribution gap in `releaseHotWalletAfterL1` is left unfixed.**
The release takes a wallet id and nothing else, so any caller can free a lock a
different Hydra L1 operation took. Closing it properly needs a per-operation
token on the wallet row — a schema change — and every caller reachable today is
now guarded at its own call site. Recorded so the next reviewer does not read the
narrow guards as the whole answer.

**`unstickPurposeLocks` and the NULL trap.** The reaper's staleness filter was
`lockedAt: { lt: … }`, which in SQL never matches a NULL — so a row that had lost
its `lockedAt` while keeping `lockPurpose` was invisible to the one job that
exists to clean it up, permanently. The invariant is that `lockPurpose` must
never outlive `lockedAt`; the reaper now also matches `lockedAt: null` so a
violation is reaped rather than parked forever. Three further unlock paths in
`wallet-timeouts` were clearing `lockedAt` without clearing `lockPurpose` and
were the way rows got there.

**F2: `CommitRecovered` decremented the pending-increment counter.** Confirmed,
not refuted, but worth recording _why_ the fix is safe in the direction it errs.
A recovered deposit is one the head declined, so it was never `CommitApproved`
and never incremented — the decrement therefore spent an unrelated in-flight
deposit's slot and cleared the fold-in UTxO set while that deposit was still
being folded in. If some future node version can emit a recovery _after_ an
approval, the cost of not decrementing is over-blocking L2 transactions until the
next `CommitFinalized`, which is the same direction the two-deposit case already
argues for. Over-blocking is a delay; under-blocking is "all inputs are spent" on
a transaction the operator has no way to diagnose.

## Round 10

**"A drain that only ever gets unusable answers should be reported as
drained."** Declined. The argument was that `lastTag: null` after a full timeout
means the node never answered at all, which is distinguishable from a real stuck
round (which always yields a tag), and that the shell procedure this was ported
from treats an empty tag as "idle or unreachable". Both are true, and the
conclusion still does not follow: a node answering non-2xx is live, may have a
round in flight, and is exactly the node whose stop we cannot verify. Calling
that drained skips the unwedge check for the only node that needs it — the bug
the `unreachable` / `timeout` split was introduced to fix. The cost of keeping it
is a full drain budget spent on a node that had nothing to drain; the cost of
changing it is a permanently stranded head. The budget half of the complaint was
real and is fixed separately: each poll is now bounded by what is left of the
drain budget, so a read can no longer overrun it by a whole request timeout.

**The `Unrecovered` outcome now covers "could not be read", which is a heavier
verdict than before.** Worth stating plainly, because it is a deliberate
trade. A node whose `/snapshot/last-seen` keeps failing is recorded `Failed` with
the reason on it, rather than being retried silently. That is the file's own
stated principle — "terminal to the TIMER, so a failure is never hidden by
silent retrying" — and `Failed` is not terminal to an operator: a restart request
is honoured from it. The alternative that was there before is worse in every
way: the rejection escaped, `lastStopUndrained` was never written, and because
`Unwedge` outranked everything the node replanned the same throwing check every
tick for good while reading as Running and usable.

**Operator restart moved above the unwedge check.** Not a finding on its own,
but the reason is worth recording so it is not reordered back: an intervention of
last resort must not be reachable only through a code path that is working. The
same argument already appears twice in `plan.ts` — at the responsive gate and in
the `Failed` branch — and the unwedge check is a longer, more failure-prone
procedure than either.

**`HydraTopupResult` described a response the endpoint had stopped returning.**
Latent rather than live — the only caller discards the value — so it is recorded
here as well as fixed: nothing misbehaved, but `const { depositTxHash } = await
topupHydraHead(...)` type-checked and was `undefined` at runtime, which is the
kind of defect that only surfaces when someone trusts the type.

## Round 11

**A round-10 fix that did not land.** Worth recording as a process note rather
than a defect: the drain's per-poll budget was added to `waitForDrain` and to
`NodeClient.fetchLastSeen`, and the call site in `stop()` was left as
`() => client.fetchLastSeen()`. TypeScript accepts the narrower arity, the
drain's own test asserted against its own fake, and the whole thing read as
landed while every poll still used the client's 10s default. The wiring now goes
through a named `drainReader`, which exists so a test can cover the join rather
than each side of it.

**Two schema-width decisions that had to be paid for at the consumer.** Both
`hydraTransactionSchema` and `hydraAssetQuantitySchema` are deliberately wide so
a frame a newer node emits cannot wedge a replay. In each case the width was
correct and the consumer was not: the transaction map retained unmodelled fields
against a budget charged from `cborHex` alone (round 9b), and the decommit
summary called a bare `BigInt()` on a value the schema admits as any string. A
widened schema is only half a decision — the reader has to be able to survive
everything the schema now lets through, and on the replay path "throws" and
"rejects" have the same permanent consequence.

**The deposits list was gated on the head being Open, and the close admission did
not know about deposits at all.** Together those stranded money with no UI path
back: an unabsorbed deposit is not part of the fanout, recovery opens a whole
deposit period AFTER absorption closes, and the Recover button lived inside a
panel that unmounted the moment the head left Open. An operator who closed a head
while a deposit was in flight therefore lost the affordance before it had ever
appeared — and head deletion then refused, naming an action the admin no longer
offered. The list is no longer status-gated (only the Add-funds form is), and
`countHydraHeadActiveWork` now counts unrecovered deposits so the close is
refused by default and says why.

**Two UI claims that described consequences the server does not allow.** The
deposit hint said an unabsorbed deposit "is recovered back to the wallet" — no
code path initiates a recovery; the reconciler only observes one an operator
asked for. The drain warning said live escrows "become unspendable until the head
is closed" — `executeHydraDecommit` refuses the drain outright while any escrow
is live, so the stated consequence cannot occur. Both are recorded because the
failure mode is the same and is easy to reintroduce: copy that describes what the
code used to do, or what someone assumed it did, reads as authoritative to the
operator making the decision.

## Round 12

**The round-11 close guard was defeated by its own reader.** Recorded because
the shape is worth remembering: the guard was added to the close endpoint AND to
`hasActiveWork`, but `describeCloseWithActiveWork` took three positional counts
with a default for the new one — and the reader behind the pre-close dialog
passed only two. So the dialog appeared (because `hasActiveWork` counted the
deposit), described a head holding nothing ("This head has ."), and offered the
acknowledgement that pre-authorises the close, at which point the server's
refusal could never fire. A defaulted parameter is how a new invariant gets
added everywhere except the one caller that matters. It now takes the whole
`HydraHeadActiveWork`, so a caller cannot omit a field, and an empty description
returns `''` rather than a sentence with nothing in it.

**A third instance of the same misleading copy.** Rounds 11 and 12 each found
one: the deposit-period hint, the drain warning, and now the in-head balance
panel, which told an operator whose deposit had missed its window that "the
funds stayed on L1. Adding them again is the way forward" — inviting a second
deposit while the first sat recoverable at the deposit script. All three said
what someone assumed the code did. Worth a standing check whenever a money path
changes: search the UI for prose describing the old behaviour, not just the
call sites.

**`requireFullTarget` was the wrong instrument, not a missing check.** Round 11
added it to stop an unattended top-up committing a best-effort shortfall, and it
does — but the disaster its own docblock described was the opposite one. Hydra
commits WHOLE UTxOs, so a bounded selection chooses which ones and cannot bound
the overshoot: `selectCommitUtxosUpToTarget` takes the smallest single UTxO that
covers the target, which for a wallet whose change has consolidated is the
wallet's entire balance, and that selection is not short, it is over — so the
new guard passed it. Recorded because the fix was to stop selecting: the
unattended path now carves the exact amount on L1 first (`exact`), which was
already implemented for the manual path. `selectCommitUtxosUpToTarget`,
`reachedTarget` and `requireFullTarget` were deleted rather than patched; a
bounded whole-UTxO selector has no correct caller.

**`Failed` deposits were being counted as money at the deposit script.** The
round-11 comment said Failed "says only that this service gave up on it", and
that is not what the code does: both writers that set Failed with a deposit hash
prove the output does not exist — `confirmed-invalid` is a phase-2 failure,
which creates no outputs, and the other branch fires only once a trusted current
slot is past the signed TTL plus grace with the hash still absent, after which
the transaction can never be included. The status's own schema comment says
"rejected/absent past its validity window; retry is safe". Counting it made
every failed top-up permanent: nothing could clear the row, because
`reconcileRecoveredHydraTopups` resolves a deposit by watching its output be
spent and an output that was never created is never spent — so the head, its
participants and their relations could not be deleted, ever. The reconciler
still watches Failed rows, which is the right place for the residual doubt.

**Two fixes were written against a read that had already been taken.** The
wallet-timeout fences (round 10) named three columns while the read that
selected the row named four, leaving out the lock's age — so a batcher's fresh
claim, which sets `lockedAt` and nothing else for a second or two, matched the
fence exactly. And `executeHydraTopup`'s release probe asked whether the
PARTICIPANT had an outstanding top-up rather than whether THIS call did, so the
409 path — refused because an earlier top-up was still Pending — kept the lock
it had just taken for the full 30-minute stale window, renewed every 30 seconds
by the auto-top-up cycle. Both are the same mistake: a fence that describes the
situation rather than the operation.

**Two hydra-host guards that only half landed.** `shouldAdoptAsRunning` (round 11) consulted `desired`, but `requestRemoval` deliberately leaves `desired`
alone — it writes `removalRequested`, because stopping the node overwrites the
state with Draining and then Stopped and the flag is what survives that. So a
node mid-teardown was still promoted to Running on a host restart and advertised
as usable. And the round-10 catch around `store.list()` in `drainRunningNodes`
stopped SIGTERM from rejecting without making it drain anything: the host then
logged "all nodes drained" and exited 0 while the runtime SIGKILLed the fleet.
The author's own unreachable log line was the tell in the first case; in the
second it was that the fix addressed the rejection rather than the outcome.

**A "no measurement" tick was being read as a good measurement.** `observe()`
reports `drift: null` for a node that is down, one that misses the 5s
responsiveness probe, and one whose chain probe misses the 8s Greetings frame.
`driftBreachFields` cleared the breach on all three, and the stall has to
survive eight consecutive ticks to earn a restart — so a node that was stalled
AND intermittently slow disarmed the watchdog that exists for exactly that node.
Worth remembering with the Jest detail that hid it: `toEqual` reads
`{ driftBreachSince: undefined }` — the shape that CLEARS the breach — as equal
to `{}`, which leaves it standing. The regression test needs `toStrictEqual`.

**The peer-change lock covered the record and not the directory.** `setPeers`
checked quiescence, wrote every key file, pruned the leftovers and only then
updated the record; the registry's write queue covered the update alone. A start
claiming the node inside that window read the OLD peer list and launched against
the NEW key files, which fixes `--initial-cluster` on a cluster that never
reaches quorum — and an unresponsive node is precisely what the plan idles on,
so it was never restarted and never failed. The fix is `store.updateAsync`,
which holds the node's queue across an awaiting mutator, with the quiescence
check moved inside it. The overlapping-writers test that came with it passes
against the old code too: the interleaving is timing-dependent and did not
reproduce, so the mechanism is pinned at the store instead.

**Reader width has to match schema width, and this file had three more.**
`hydraOutputValueSchema` admits a nested map under any key — `lovelace`
included — and its keys are node-supplied strings, and `summarizeDistributedUtxo`
was written as if neither were true: an unchecked cast on the lovelace branch
reaching `.trim()` on an object, and `assets['constructor']` answering with a
function that `BigInt()` throws on. Both throws land inside the replay, and a
rejected frame is re-rejected on every reconnect. `__proto__` needed the output
object to be null-prototype as well, since assigning it on a literal sets the
prototype instead of the key. The other two: `IgnoredHeadInitializing` was
registered head-scoped although its `headId` names the head the node DECLINED to
join, so the pinned-head check rejected the ordinary case; and the
`DecommitInvalid` reader called `resolveTxHash` with no try, though the schema
checks the cborHex is hex of a plausible length and not that it decodes (every
input probed throws with a CBOR error). Three `z.strictObject` islands inside
`hydraProtocolParametersSchema`, itself `looseObject`, are the same family: an
additive upstream field would have failed every L2 build on the head.

## Round 13

Nothing was refuted this round: every finding the four reviewers raised was
confirmed against the code and fixed. What is recorded here is the reasoning a
later reviewer is most likely to re-open.

**json-bigint throws on a long fraction, and a fallback to `JSON.parse` would
be worse than the bug.** `parse.js` sends every literal over 15 characters to
`BigInt()` — sign, decimal point and exponent included in that length — with no
check for a fractional part, so `0.05770000000000` and a drift of
`773500.891234567` both throw. Retrying with plain `JSON.parse` trades the throw
for rounded asset quantities above 2^53 - 1, which is the one thing
`parseHydraJson` exists to prevent. The fallback therefore lifts only the
offending literals out of the document — a string-aware scan, so a literal
inside a JSON string stays the string it was — parses the rest through
json-bigint untouched, and puts the exact doubles back afterwards. A document
that already contains the placeholder text is not rescued: it re-throws the
original error rather than substituting something it could not unambiguously
undo.

**Bounding a value is not the same as rejecting a frame.** `summarizeDistributedUtxo`
now drops the summary when a quantity is negative or a running total passes the
`int8` its column is, rather than refusing the frame. Both directions were real
outages from the same cause: an unbounded sum reaches `settledLovelace`, the
write throws, and the withdrawal stays Approved and is retried forever — the
permanence of a rejected frame arrived at from the other side. Same rule for the
drift-report dedupe sets: at `MAX_REPORTED_DRIFT_KEYS` they stop recording AND
stop reporting, because a key that cannot be recorded would otherwise be
re-reported on every frame.

**A guard that reads a mutable field is not a guard.** Both reconcilers
recognised the commit's display row by comparing its deposit hash against
`HydraLocalParticipant.commitTxHash`. That hash changes: a commit whose evidence
is cleared can be retried, and the abandoned row then stops matching at exactly
the moment the retry is holding the wallet — so resolving it released the
retry's lock. Fixed with a column (`HydraTopup.isInitialCommit`, backfilled from
the same comparison) rather than by splitting `lockPurpose` into commit and
top-up values: distinct purposes would still let one commit's row release
another commit's lock, which is the same bug in a narrower window.

**Damping is part of an unattended loop, not a nicety.** `runHydraAutoTopupCycle`
had one brake — a deposit in flight — and a failure leaves nothing in flight, so
a rule whose top-ups keep failing retried every thirty seconds forever: ~2,880
`HydraTopup` and `HydraHeadError` rows a day, burying a genuinely stranded
deposit's Recover button in an unfiltered list. The backoff doubles from five
minutes to an hour per participant, so a rule that recovers on its own still
does, within the hour. Its companion is a floor: a lovelace top-up below the
minimum a carved output costs could never be built, and that is now refused
where the operator is present to be told — the rule endpoint, the top-up
endpoint, and `carveExactUtxo` itself.

**`isRunning` answers "do I hold a handle?", not "is a process running?".** The
shutdown drain skipped any node whose handle this host did not hold, which
`stop` would have re-adopted by pid and drained. A SIGTERM before boot has
adopted the fleet, and an entry `revalidateAdopted` drops, both produce that
state — and the host then logged "all nodes drained" and exited 0 while the
runtime SIGKILLed a node mid-round. The gate could not simply be removed:
`stop` on a genuinely stopped record writes `lastStopUndrained`, which schedules
a stranded-round check on the next start. So it now asks the record whether the
node is supposed to be up, re-read after the wait for the tick's hold — the
first version of the fix stopped a node the tick had just stopped, on a record
that still said `Draining`.

## Round 14

Nothing was refuted this round either. Two of the fixes reverse reasoning
recorded in Round 13, and both reversals are here so the next reviewer does not
restore the earlier version.

**`@updatedAt` is not an age signal wherever a second loop writes the row.**
Round 13 gave the auto-top-up backoff a per-participant cooldown aged off
`HydraTopup.updatedAt`. That column is `@updatedAt`, and
`reconcileRecoveredHydraTopups` rewrites every recovered row on its own cycle —
so the newest failure kept looking newer than it was, the cooldown never
elapsed, and a rule whose top-ups fail would have been damped into never
retrying at all: the opposite failure to the one the backoff was added for. It
now ages off `createdAt`, which nothing rotates. The same rule caught the
close-admission reaper, which aged candidates off `HydraHead.updatedAt` while
the connection manager bumps that row on every successful attach (it increments
the ownership fence). A head reconnecting more often than the ten-minute window
never looked stale, so its close latch stayed set and it went on refusing every
new L2 reservation. Fixed with `HydraHead.closingSince`, written when the latch
is taken and cleared with it.

**A `Failed` node still has to be drainable.** Round 13 recorded that `Failed`
is terminal to the timer so a failure is never hidden by silent retrying, and
that `mayStillBeRunning` should answer for the drain gate. Both stand — but
`Failed` in the registry says nothing about whether a process is alive:
`unwedgeNode` marks a node that answers but will not progress. So the planner
now returns `Stop` for a `Failed` record whose `desired` is `Stopped` and whose
process is observed running, `mayStillBeRunning` consults liveness by pid rather
than answering `false` outright, and `requestStart` sets `restartRequested` so
the operator's `/start` on a failed node is honoured. None of that starts a
failed node on its own; every path still needs an operator.

**Node-supplied strings must never index a plain object.** Two more sites of the
same class: `EXPLANATIONS[tag]` answered `describePostTxError('toString')` with a
function, which `??` does not catch because a function is not nullish, and it
was returned through a `string` signature into `HydraDecommit.failureReason` —
Prisma refused the write, the refusal was never recorded, and the withdrawal
stayed Pending, which is the state that makes every later withdrawal for that
participant refuse as "still settling". The decoder's `HydraValue` had the same
shape for policy ids. Both now go through `getOwnValue` / a null-prototype
object.

**A wallet lock is not this path's to clear just because the request names the
wallet.** The transactional error transitions and the V2 request-failure
unlocker both cleared `lockedAt` by wallet id. A Hydra L1 deposit holds the same
`HotWallet` across a full L1 confirmation with `lockPurpose = 'hydra-l1'` and
never attaches a `PendingTransaction`, so a payment-path failure freed a carve
mid-flight and the next batch tick built over its inputs — one of the two dies
on chain as `BadInputsUTxO`. Every clear is now fenced on `lockPurpose: null`.

**An escrow acknowledgement has to survive the retry that skips the create.**
`reserveNodeForExchange` acked the Host only in the branch that had just written
the participant row. A first attempt that died after the create — or whose ack
call failed — left the node in `PendingEscrow`, and the retry found the row and
returned without acking. The Host's supervisor removes an unacknowledged node
once its escrow TTL is up (an hour by default), taking the node named by an
invite that may be valid for another thirty days and leaving a participant row
pointing at nothing. The ack is now unconditional; the Host's handler is
idempotent.

**Copy that describes a rule the code does not implement is a bug in three
places.** The withdrawal withholds the smallest whole UTxO worth at least 5 ADA,
because collateral cannot be assembled from several inputs — so what is withheld
is routinely more than 5 ADA. The admin UI, the operations guide and the OpenAPI
description all said "5 ADA stays behind". All three now describe the whole-UTxO
rule. The top-up path's documented statuses were stale in the same way: the
handler throws 400 and 502 that the OpenAPI block said it never would.
