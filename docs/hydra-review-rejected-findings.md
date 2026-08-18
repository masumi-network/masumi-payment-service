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

**What was still wrong.** Disjointness proves the two outputs *exist*, not that
both *left*. Every allowance was derived from value multisets, which cannot tell
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
throws when one output *reference* appears in two partitions, so the partitions
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
marked stalled by `markReconciliationStalled`, and replay wedges for *every* request on it —
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
first *declares* it, not on the later ones that carry it to finality. See the round-3 entry
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
`previous.outputs` is the *canonical* output set and spans all three partitions —
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
why: its reservation is the only thing standing between a retry and a *second* lock built
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

**Why it is not a defect.** Only *some* protocol errors are pre-dispatch. The command
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

Half of the original finding *was* real and was fixed: the hash is now written before
submission rather than after, so a process that dies between submit and update leaves a
recoverable record rather than an orphan transaction.

### `HydraNode` / `HydraConnectionManager` exceed the 750-line ceiling

**Claim.** Two files are over the repository's hard file-length limit.

**Why it is not a defect *now*.** They were, and they were split — see ADR 0014 and the
registry / `HeadSession` / collaborator decomposition. A reviewer measuring the files as
they stand on `gd/impl-hydra` will find them under the ceiling. Re-file only with the
current line count in hand.
