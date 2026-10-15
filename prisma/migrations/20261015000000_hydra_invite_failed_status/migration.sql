-- A redemption whose signature does not verify ends the invite as Failed.
ALTER TYPE "HydraInviteStatus" ADD VALUE IF NOT EXISTS 'Failed';
