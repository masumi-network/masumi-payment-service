BEGIN;

ALTER TABLE "PaymentRequest"
ADD COLUMN "cardanoFeeAccountingVersion" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "PaymentRequest"
ALTER COLUMN "cardanoFeeAccountingVersion" SET DEFAULT 1;

ALTER TABLE "PurchaseRequest"
ADD COLUMN "cardanoFeeAccountingVersion" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "PurchaseRequest"
ALTER COLUMN "cardanoFeeAccountingVersion" SET DEFAULT 1;

COMMIT;
