import { prisma } from '@/utils/db';
import { InsufficientFundsError } from '@/utils/errors/insufficient-funds-error';
import {
  Network,
  Permission,
  PurchasingAction,
  WalletBase,
  WalletType,
} from '@prisma/client';

async function handlePurchaseCreditInit({
  id,
  cost,
  metadata,
  network,
  blockchainIdentifier,
  contractAddress,
  sellerVkey,
  sellerAddress,
  payByTime,
  submitResultTime,
  unlockTime,
  externalDisputeUnlockTime,
  inputHash,
}: {
  id: string;
  cost: Array<{ amount: bigint; unit: string }>;
  metadata: string | null | undefined;
  network: Network;
  blockchainIdentifier: string;
  contractAddress: string;
  sellerVkey: string;
  sellerAddress: string;
  payByTime: bigint;
  submitResultTime: bigint;
  unlockTime: bigint;
  externalDisputeUnlockTime: bigint;
  inputHash: string;
}) {
  return await prisma.$transaction(
    async (prisma) => {
      const paymentSource = await prisma.paymentSource.findUnique({
        where: {
          network_smartContractAddress: {
            network: network,
            smartContractAddress: contractAddress,
          },
          deletedAt: null,
        },
      });
      if (!paymentSource) {
        throw Error('Invalid paymentSource: ' + paymentSource);
      }
      let sellerWallet: WalletBase | null = await prisma.walletBase.findUnique({
        where: {
          paymentSourceId_walletVkey_walletAddress_type: {
            paymentSourceId: paymentSource.id,
            walletVkey: sellerVkey,
            walletAddress: sellerAddress,
            type: WalletType.Seller,
          },
        },
      });

      const result = await prisma.apiKey.findUnique({
        where: { id: id },
        include: {
          RemainingUsageCredits: true,
        },
      });
      if (!result) {
        throw Error('Invalid id: ' + id);
      }
      if (
        result.permission != Permission.Admin &&
        !result.networkLimit.includes(network)
      ) {
        throw Error('No permission for network: ' + network + ' for id: ' + id);
      }

      if (!sellerWallet) {
        sellerWallet = await prisma.walletBase.create({
          data: {
            walletVkey: sellerVkey,
            walletAddress: sellerAddress,
            type: WalletType.Seller,
            PaymentSource: { connect: { id: paymentSource.id } },
          },
        });
      }

      const remainingAccumulatedUsageCredits: Map<string, bigint> = new Map<
        string,
        bigint
      >();

      // Sum up all purchase amounts
      result.RemainingUsageCredits.forEach((request) => {
        if (!remainingAccumulatedUsageCredits.has(request.unit)) {
          remainingAccumulatedUsageCredits.set(request.unit, 0n);
        }
        remainingAccumulatedUsageCredits.set(
          request.unit,
          remainingAccumulatedUsageCredits.get(request.unit)! + request.amount,
        );
      });

      const totalCost: Map<string, bigint> = new Map<string, bigint>();
      cost.forEach((amount) => {
        if (!totalCost.has(amount.unit)) {
          totalCost.set(amount.unit, 0n);
        }
        totalCost.set(amount.unit, totalCost.get(amount.unit)! + amount.amount);
      });
      const newRemainingUsageCredits: Map<string, bigint> =
        remainingAccumulatedUsageCredits;

      if (result.usageLimited) {
        for (const [unit, amount] of totalCost) {
          if (!newRemainingUsageCredits.has(unit)) {
            throw new InsufficientFundsError(
              'Credit unit not found: ' + unit + ' for id: ' + id,
            );
          }
          newRemainingUsageCredits.set(
            unit,
            newRemainingUsageCredits.get(unit)! - amount,
          );
          if (newRemainingUsageCredits.get(unit)! < 0) {
            throw new InsufficientFundsError(
              'Not enough ' +
                unit +
                ' tokens to handleCreditUsage for id: ' +
                id,
            );
          }
        }
      }

      // Create new usage amount records with unique IDs
      const updatedUsageAmounts = Array.from(
        newRemainingUsageCredits.entries(),
      ).map(([unit, amount]) => ({
        id: `${id}-${unit}`, // Create a unique ID
        amount: amount,
        unit: unit,
      }));
      if (result.usageLimited) {
        await prisma.apiKey.update({
          where: { id: id },
          data: {
            RemainingUsageCredits: {
              set: updatedUsageAmounts,
            },
          },
        });
      }

      const purchaseRequest = await prisma.purchaseRequest.create({
        data: {
          totalBuyerCardanoFees: BigInt(0),
          totalSellerCardanoFees: BigInt(0),
          requestedBy: { connect: { id: id } },
          PaidFunds: {
            create: Array.from(totalCost.entries()).map(([unit, amount]) => ({
              amount: amount,
              unit: unit,
            })),
          },
          payByTime: payByTime,
          submitResultTime: submitResultTime,
          PaymentSource: { connect: { id: paymentSource.id } },
          resultHash: null,
          sellerCoolDownTime: 0,
          buyerCoolDownTime: 0,
          SellerWallet: {
            connect: { id: sellerWallet.id },
          },
          blockchainIdentifier: blockchainIdentifier,
          inputHash: inputHash,
          NextAction: {
            create: {
              requestedAction: PurchasingAction.FundsLockingRequested,
            },
          },
          externalDisputeUnlockTime: externalDisputeUnlockTime,
          unlockTime: unlockTime,
          metadata: metadata,
        },
        include: {
          SellerWallet: true,
          SmartContractWallet: { where: { deletedAt: null } },
          PaymentSource: true,
          PaidFunds: true,
          NextAction: true,
          CurrentTransaction: true,
          WithdrawnForSeller: true,
          WithdrawnForBuyer: true,
        },
      });

      return purchaseRequest;
    },
    { isolationLevel: 'Serializable', maxWait: 15000, timeout: 15000 },
  );
}

export const creditTokenRepository = { handlePurchaseCreditInit };
