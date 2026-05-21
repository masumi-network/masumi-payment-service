-- Relax FeeReceiverNetworkWallet FK from CASCADE to SET NULL. The column
-- `adminWalletId` is nullable since the V2 payment-source-type migration
-- (V2 sources have no fee receiver), so cascading a delete of one fee-receiver
-- AdminWallet row would wipe out an active V2 PaymentSource and every
-- payment/purchase/registry row hanging off it.

ALTER TABLE "PaymentSource" DROP CONSTRAINT "PaymentSource_adminWalletId_fkey";
ALTER TABLE "PaymentSource" ADD CONSTRAINT "PaymentSource_adminWalletId_fkey"
    FOREIGN KEY ("adminWalletId") REFERENCES "AdminWallet"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
