import { HotWallet, OnChainState, PurchasingAction } from '@prisma/client';
import { prisma } from '..';
import { logger } from '@/utils/logger';

export async function lockAndQueryPurchases({
  purchasingAction,
  unlockTime,
  onChainState = undefined,
  submitResultTime = undefined,
  resultHash = undefined,
}: {
  purchasingAction: PurchasingAction;
  unlockTime?: { lte: number } | undefined | { gte: number };
  onChainState?: OnChainState | { in: OnChainState[] } | undefined;
  submitResultTime?: { lte: number } | undefined | { gte: number };
  resultHash?: string | null | undefined;
}) {
  return await prisma.$transaction(
    async (prisma) => {
      try {
        const minCooldownTime = Date.now() - 1000 * 60 * 3;
        const paymentSources = await prisma.paymentSource.findMany({
          where: {
            syncInProgress: false,
            deletedAt: null,
            disablePaymentAt: null,
          },
          include: {
            PurchaseRequests: {
              where: {
                submitResultTime: submitResultTime,
                unlockTime: unlockTime,
                NextAction: {
                  requestedAction: purchasingAction,
                  errorType: null,
                },
                resultHash: resultHash,
                onChainState: onChainState,
                SmartContractWallet: {
                  PendingTransaction: { is: null },
                  lockedAt: null,
                  deletedAt: null,
                },
                //we only want to lock the purchase if the cooldown time has passed
                buyerCoolDownTime: { lte: minCooldownTime },
              },
              orderBy: {
                createdAt: 'asc',
              },
              include: {
                NextAction: true,
                CurrentTransaction: true,
                PaidFunds: true,
                SellerWallet: true,
                SmartContractWallet: {
                  include: {
                    Secret: true,
                  },
                  where: {
                    deletedAt: null,
                  },
                },
              },
            },
            AdminWallets: true,
            FeeReceiverNetworkWallet: true,
            PaymentSourceConfig: true,
          },
        });
        const purchasingWallets: HotWallet[] = [];
        const newPaymentSources = [];
        for (const paymentSource of paymentSources) {
          const purchasingRequests = [];
          const minCooldownTime = paymentSource.cooldownTime;
          for (const purchasingRequest of paymentSource.PurchaseRequests) {
            if (
              purchasingRequest.buyerCoolDownTime >
              Date.now() - minCooldownTime
            ) {
              continue;
            }
            const wallet = purchasingRequest.SmartContractWallet;
            if (
              wallet != null &&
              !purchasingWallets.some((w) => w.id === wallet.id)
            ) {
              const result = await prisma.hotWallet.update({
                where: { id: wallet.id, deletedAt: null },
                data: { lockedAt: new Date() },
              });
              wallet.pendingTransactionId = result.pendingTransactionId;
              purchasingWallets.push(wallet);
              purchasingRequests.push(purchasingRequest);
            }
          }
          if (purchasingRequests.length > 0) {
            newPaymentSources.push({
              ...paymentSource,
              PurchaseRequests: purchasingRequests,
            });
          }
        }
        return newPaymentSources;
      } catch (error) {
        logger.error('Error locking and querying purchases', error);
        throw error;
      }
    },
    { isolationLevel: 'Serializable' },
  );
}
