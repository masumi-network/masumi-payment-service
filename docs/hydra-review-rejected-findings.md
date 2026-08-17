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
