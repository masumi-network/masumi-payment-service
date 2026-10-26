ALTER TYPE "WebhookEventType" ADD VALUE 'HYDRA_HEAD_CONTEST_WATCH_ALERT';

ALTER TABLE "HydraHead"
  ADD COLUMN "contestWatchClosedAlertedAt" TIMESTAMP(3),
  ADD COLUMN "contestWatchIssueSignature" TEXT,
  ADD COLUMN "contestWatchIssueSince" TIMESTAMP(3),
  ADD COLUMN "contestWatchIssueAlertedAt" TIMESTAMP(3);
