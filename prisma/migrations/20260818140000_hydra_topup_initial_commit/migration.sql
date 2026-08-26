-- Which deposit row is the head's initial commit, written down rather than guessed.
--
-- The commit handler records its commit as a deposit so it appears in the list
-- with a Recover button, and both reconcilers then have to know not to release
-- the participant's wallet for it: the commit reconciler owns that lock, and a
-- second releaser for one deposit frees whatever Hydra operation holds the
-- wallet by the time it runs, because the release is fenced on a shared lock
-- purpose rather than on an operation's identity.
--
-- They recognised the row by comparing its deposit hash against
-- HydraLocalParticipant.commitTxHash, which is mutable: a commit whose evidence
-- is cleared can be retried, the participant then names the new hash, and the
-- previous commit's row stops matching. It is at that point that its own
-- resolution releases a lock some other operation is holding.
--
-- Backfilled from the same comparison, which is correct for every row written
-- before this column existed and no commit has since been retried over.
ALTER TABLE "HydraTopup" ADD COLUMN "isInitialCommit" BOOLEAN NOT NULL DEFAULT false;

UPDATE "HydraTopup" AS t
SET "isInitialCommit" = true
FROM "HydraLocalParticipant" AS p
WHERE t."hydraLocalParticipantId" = p."id"
  AND t."depositTxHash" IS NOT NULL
  AND t."depositTxHash" = p."commitTxHash";
