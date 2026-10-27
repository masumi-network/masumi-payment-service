-- HydraStoredSnapshot now also gets the signed snapshots that replay rejects,
-- so this newest-only copy is redundant.
DROP TABLE "HydraHeadSignedSnapshot";
