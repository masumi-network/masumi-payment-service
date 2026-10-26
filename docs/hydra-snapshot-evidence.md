# Hydra signed snapshot evidence

## Storage behavior

- VERIFIED (code): `src/lib/hydra/hydra/node-history-replay.ts` calls `persistVerifiedSnapshot` only after party signatures and the accumulator pass. It also checks the predecessor transition for snapshots after the first one. Replay waits for the write before it adopts a new snapshot. A failed write fails the history pass.
- VERIFIED (code): `src/services/hydra-snapshot-store/store.ts` writes one append-only row per head, snapshot number, and snapshot version. It compares authenticated fields and signatures on redelivery. A conflicting signed commitment fails closed. A different UTxO reference map with the same signed commitment leaves the first stored map intact.
- VERIFIED (code): The row contains the snapshot number, version, accumulator, UTxO partitions, deposit transaction ID, and party signatures. It excludes the unsigned `confirmed` transaction list. Hydra 2.3 signatures bind the output multiset, not each UTxO reference. The stored reference map therefore remains endpoint-trusted evidence, not signed evidence.
- VERIFIED (code): The connection manager and read-only contest observer both pass verified frames to the store. The Prisma migration must be applied before enabling this code.
- VERIFIED (code): `prisma/models/hydra-stored-snapshot.prisma` deletes stored snapshots with their head. The guarded relation delete at `src/routes/api/hydra/relation/index.ts:306-359` permits this only after Final status, fanout, reconciliation, and settlement checks. Export required evidence before deleting a final relation.
- VERIFIED (code): `src/services/hydra-contest-watch/watch.ts` compares a closed node's observed on-chain snapshot number with the latest stored signed snapshot number. It uses the stored number when the restarted node reports an older number or no verified number.

## Recovery limit

- REPORTED (live drill): `docs/hydra-persistence-recovery-verification.md:45` records `SideLoadSvNumberInvalid` when a newer stored snapshot was loaded into a restarted stock node. Its line 69 reports a separate code-based `SideLoadUTxOToCommitInvalid` constraint for a lagging node.
- INFERRED: Storing the snapshot preserves evidence but does not make a wiped node resume at that snapshot. The service has no external L1 Close builder. Its best-effort Init chain anchor can replay L1 activity, but it cannot reconstruct later L2 snapshots. Operators must still protect the hydra-node persistence volume and retain its backup. Recovery after loss requires a separate, tested procedure.
- INFERRED: If the node is unreachable, this watch cannot read the Close snapshot number. Its independent L1 observer identifies a Close but does not decode the snapshot number. A stored number alone cannot prove a contest gap in that case.
- INFERRED: The stored UTxO map may expose private head activity. Restrict database and backup access to the same operators that can read the hydra-node persistence volume.

## Least confident decisions

1. The existing live drill used hydra-node 2.3.0. Re-test the side-load limitation against the deployed node version before choosing a recovery design.
2. The write path stores every verified snapshot. Large heads can increase database size and replay time. Measure both under the production workload before setting retention.
