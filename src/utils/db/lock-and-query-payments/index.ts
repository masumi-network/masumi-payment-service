import { HotWallet, OnChainState, PaymentAction } from '@prisma/client';
import { prisma } from '..';

export async function lockAndQueryPayments({
  paymentStatus,
  submitResultTime = undefined,
  onChainState = undefined,
  resultHash = undefined,
  requestedResultHash = undefined,
  unlockTime = undefined,
}: {
  paymentStatus: PaymentAction | { in: PaymentAction[] };
  submitResultTime?: { lte: number } | undefined | { gte: number };
  onChainState?: OnChainState | { in: OnChainState[] } | undefined;
  resultHash?: string | { not: string | null } | undefined;
  requestedResultHash?: string | { not: null } | undefined;
  unlockTime?: { lte: number } | undefined | { gte: number };
}) {
  return await prisma.$transaction(
    async (prisma) => {
      const minCooldownTime = Date.now() - 1000 * 60 * 3;
      const paymentSources = await prisma.paymentSource.findMany({
        where: {
          syncInProgress: false,
          deletedAt: null,
          disablePaymentAt: null,
        },
        include: {
          PaymentRequests: {
            where: {
              NextAction: {
                requestedAction: paymentStatus,
                errorType: null,
                resultHash: requestedResultHash,
              },
              submitResultTime: submitResultTime,
              unlockTime: unlockTime,
              SmartContractWallet: {
                PendingTransaction: { is: null },
                lockedAt: null,
                deletedAt: null,
              },
              onChainState: onChainState,
              //we only want to lock the payment if the cooldown time has passed
              sellerCoolDownTime: { lte: minCooldownTime },
              resultHash: resultHash,
            },
            include: {
              NextAction: true,
              CurrentTransaction: true,
              RequestedFunds: true,
              BuyerWallet: true,
              SmartContractWallet: {
                include: {
                  Secret: true,
                },
                where: { deletedAt: null },
              },
            },
            orderBy: {
              createdAt: 'asc',
            },
          },
          AdminWallets: true,
          FeeReceiverNetworkWallet: true,
          PaymentSourceConfig: true,
        },
        orderBy: {
          createdAt: 'asc',
        },
      });
      const sellingWallets: HotWallet[] = [];

      const newPaymentSources = [];
      for (const paymentSource of paymentSources) {
        const paymentRequests = [];
        const minCooldownTime = paymentSource.cooldownTime;
        for (const paymentRequest of paymentSource.PaymentRequests) {
          if (
            paymentRequest.sellerCoolDownTime >
            Date.now() - minCooldownTime
          ) {
            continue;
          }

          const wallet = paymentRequest.SmartContractWallet;
          if (
            wallet != null &&
            !sellingWallets.some((w) => w.id === wallet.id)
          ) {
            const result = await prisma.hotWallet.update({
              where: { id: wallet.id, deletedAt: null },
              data: { lockedAt: new Date() },
            });
            wallet.pendingTransactionId = result.pendingTransactionId;
            sellingWallets.push(wallet);
            paymentRequests.push(paymentRequest);
          }
        }
        if (paymentRequests.length > 0) {
          newPaymentSources.push({
            ...paymentSource,
            PaymentRequests: paymentRequests,
          });
        }
      }
      return newPaymentSources;
    },
    { isolationLevel: 'Serializable', timeout: 10000 },
  );
}
