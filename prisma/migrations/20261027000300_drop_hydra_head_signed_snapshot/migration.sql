-- HydraStoredSnapshot keeps every verified signed snapshot, including one a
-- rejected transition reached, so this newest-only copy is redundant.
DROP TABLE "HydraHeadSignedSnapshot";
