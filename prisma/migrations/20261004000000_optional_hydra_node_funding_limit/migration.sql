ALTER TABLE "HydraLocalParticipant"
ADD COLUMN "automaticFundingLimitLovelace" BIGINT;

ALTER TABLE "HydraLocalParticipant"
ADD CONSTRAINT "HydraLocalParticipant_automaticFundingLimitLovelace_nonnegative"
CHECK ("automaticFundingLimitLovelace" IS NULL OR "automaticFundingLimitLovelace" >= 0);
