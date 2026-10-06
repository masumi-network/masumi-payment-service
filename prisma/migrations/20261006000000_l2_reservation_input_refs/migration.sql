ALTER TABLE "Transaction"
ADD COLUMN "l2ReservationInputRefs" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "l2ReleasedByInputProofAt" TIMESTAMP(3);
