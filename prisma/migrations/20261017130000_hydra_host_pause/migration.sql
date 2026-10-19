-- AlterTable
ALTER TABLE "HydraHost" ADD COLUMN     "pauseStopRequestedAt" TIMESTAMP(3),
ADD COLUMN     "pausedAt" TIMESTAMP(3),
ADD COLUMN     "pausedNodeIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

