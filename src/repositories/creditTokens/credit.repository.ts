import { prisma } from '@/utils/db';
import { InsufficientFundsError } from '@/utils/errors/insufficient-funds-error';
import {
  Network,
  PaymentType,
  Permission,
  PurchasingAction,
  WalletType,
} from '@prisma/client';

async function handlePurchaseCreditInit({
  id,
  cost,
  metadata,
  network,
  blockchainIdentifier,
  paymentType,
  contractAddress,
  sellerVkey,
  submitResultTime,
  unlockTime,
  externalDisputeUnlockTime,
  inputHash,
}: {
  id: string;
  cost: { amount: bigint; unit: string }[];
  metadata: string | null | undefined;
  network: Network;
  blockchainIdentifier: string;
  paymentType: PaymentType;
  contractAddress: string;
  sellerVkey: string;
  submitResultTime: bigint;
  unlockTime: bigint;
  externalDisputeUnlockTime: bigint;
  inputHash: string;
}) {
  return await prisma.$transaction(
    async (transaction) => {
      const result = await transaction.apiKey.findUnique({
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
        await transaction.apiKey.update({
          where: { id: id },
          data: {
            RemainingUsageCredits: {
              set: updatedUsageAmounts,
            },
          },
        });
      }

      const paymentSource = await transaction.paymentSource.findUnique({
        where: {
          network_smartContractAddress: {
            network: network,
            smartContractAddress: contractAddress,
          },
          paymentType: paymentType,
        },
      });
      if (!paymentSource) {
        throw Error('Invalid paymentSource: ' + paymentSource);
      }

      const sellerWallet = await transaction.walletBase.findUnique({
        where: {
          paymentSourceId_walletVkey_type: {
            paymentSourceId: paymentSource.id,
            walletVkey: sellerVkey,
            type: WalletType.Seller,
          },
        },
      });

      const purchaseRequest = await prisma.purchaseRequest.create({
        data: {
          requestedBy: { connect: { id: id } },
          PaidFunds: {
            create: Array.from(totalCost.entries()).map(([unit, amount]) => ({
              amount: amount,
              unit: unit,
            })),
          },
          submitResultTime: submitResultTime,
          PaymentSource: { connect: { id: paymentSource.id } },
          resultHash: '',
          sellerCoolDownTime: 0,
          buyerCoolDownTime: 0,
          SellerWallet: {
            connectOrCreate: {
              where: {
                id: sellerWallet?.id ?? 'not-found',
              },
              create: {
                walletVkey: sellerVkey,
                paymentSourceId: paymentSource.id,
                type: WalletType.Seller,
              },
            },
          },
          blockchainIdentifier: blockchainIdentifier,
          inputHash: inputHash,
          NextAction: {
            create: {
              requestedAction: PurchasingAction.FundsLockingRequested,
              inputHash: inputHash,
            },
          },
          externalDisputeUnlockTime: externalDisputeUnlockTime,
          unlockTime: unlockTime,
          metadata: metadata,
        },
        include: {
          SellerWallet: true,
          SmartContractWallet: true,
          PaymentSource: true,
          PaidFunds: true,
          NextAction: true,
          CurrentTransaction: true,
        },
      });

      return purchaseRequest;
    },
    { isolationLevel: 'ReadCommitted', maxWait: 15000, timeout: 15000 },
  );
}

export const creditTokenRepository = { handlePurchaseCreditInit };
