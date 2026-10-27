CREATE TABLE "HydraStoredSnapshot" (
  "id" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "hydraHeadId" TEXT NOT NULL,
  "headIdentifier" TEXT NOT NULL,
  "snapshotNumber" BIGINT NOT NULL,
  "snapshotVersion" BIGINT NOT NULL,
  "signedIdentityJson" TEXT NOT NULL,
  "signedSnapshotJson" TEXT NOT NULL,
  CONSTRAINT "HydraStoredSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "HydraStoredSnapshot_hydraHeadId_snapshotNumber_snapshotVersion_key"
  ON "HydraStoredSnapshot"("hydraHeadId", "snapshotNumber", "snapshotVersion");
CREATE INDEX "HydraStoredSnapshot_hydraHeadId_snapshotNumber_idx"
  ON "HydraStoredSnapshot"("hydraHeadId", "snapshotNumber" DESC);
ALTER TABLE "HydraStoredSnapshot" ADD CONSTRAINT "HydraStoredSnapshot_hydraHeadId_fkey"
  FOREIGN KEY ("hydraHeadId") REFERENCES "HydraHead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
