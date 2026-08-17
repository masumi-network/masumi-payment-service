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
