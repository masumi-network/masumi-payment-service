-- The existing nonce and issuerSignature values remain readable until the
-- startup backfill encrypts them. The service runs that backfill before routes
-- or jobs start, and new rows always populate nonceHash.
ALTER TABLE "HydraHeadInvite" ADD COLUMN "nonceHash" TEXT;
DROP INDEX "HydraHeadInvite_nonce_key";
CREATE UNIQUE INDEX "HydraHeadInvite_nonceHash_key" ON "HydraHeadInvite" ("nonceHash");
