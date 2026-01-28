import {
  HotWalletType,
  OnChainState,
  PurchasingAction,
} from '@/generated/prisma/client';
import { prisma } from '..';
import { logger } from '@/utils/logger';

export async function lockAndQueryPurchases({
  purchasingAction,
  maxBatchSize,
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
  maxBatchSize: number;
}) {
  return await prisma.$transaction(
    async (prisma) => {
      try {
        const paymentSources = await prisma.paymentSource.findMany({
          where: {
            syncInProgress: false,
            deletedAt: null,
            disablePaymentAt: null,
          },
          include: {
            AdminWallets: true,
            FeeReceiverNetworkWallet: true,
            PaymentSourceConfig: true,
            HotWallets: {
              where: {
                PendingTransaction: { is: null },
                lockedAt: null,
                deletedAt: null,
                type: HotWalletType.Purchasing,
              },
              select: {
                id: true,
              },
            },
          },
        });
        const newPaymentSources = [];
        for (const paymentSource of paymentSources) {
          const purchasingRequests = [];
          const minCooldownTime = paymentSource.cooldownTime;
          for (const hotWallet of paymentSource.HotWallets) {
            const potentialPurchasingRequests =
              await prisma.purchaseRequest.findMany({
                where: {
                  buyerCoolDownTime: { lt: Date.now() - minCooldownTime },
                  submitResultTime: submitResultTime,
                  unlockTime: unlockTime,
                  NextAction: {
                    requestedAction: purchasingAction,
                    errorType: null,
                  },
                  resultHash: resultHash,
                  onChainState: onChainState,
                  SmartContractWallet: {
                    id: hotWallet.id,
                    PendingTransaction: { is: null },
                    lockedAt: null,
                    deletedAt: null,
                  },
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
                  },
                },
                take: maxBatchSize,
              });
            if (potentialPurchasingRequests.length > 0) {
              const hotWalletResult = await prisma.hotWallet.update({
                where: { id: hotWallet.id, deletedAt: null },
                data: { lockedAt: new Date() },
              });
              potentialPurchasingRequests.forEach((purchasingRequest) => {
                purchasingRequest.SmartContractWallet!.pendingTransactionId =
                  hotWalletResult.pendingTransactionId;
                purchasingRequest.SmartContractWallet!.lockedAt =
                  hotWalletResult.lockedAt;
              });

              purchasingRequests.push(...potentialPurchasingRequests);
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
