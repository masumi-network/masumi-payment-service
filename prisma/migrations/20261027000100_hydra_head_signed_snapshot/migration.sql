-- CreateTable
CREATE TABLE "HydraHeadSignedSnapshot" (
    "hydraHeadId" TEXT NOT NULL,
    "snapshotNumber" BIGINT NOT NULL,
    "snapshotVersion" BIGINT NOT NULL,
    "confirmedSnapshot" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HydraHeadSignedSnapshot_pkey" PRIMARY KEY ("hydraHeadId")
);

-- AddForeignKey
ALTER TABLE "HydraHeadSignedSnapshot" ADD CONSTRAINT "HydraHeadSignedSnapshot_hydraHeadId_fkey" FOREIGN KEY ("hydraHeadId") REFERENCES "HydraHead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
