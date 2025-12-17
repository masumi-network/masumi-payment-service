import { creditTokenRepository } from '@/repositories/creditTokens';
import { InsufficientFundsError } from '@/utils/errors/insufficient-funds-error';
import { logger } from '@/utils/logger';
import { Network } from '@prisma/client';
import createHttpError from 'http-errors';
export async function handlePurchaseCreditInit({
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
  externalDisputeUnlockTime,
  unlockTime,
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
  externalDisputeUnlockTime: bigint;
  unlockTime: bigint;
  inputHash: string;
}) {
  try {
    return await creditTokenRepository.handlePurchaseCreditInit({
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
      externalDisputeUnlockTime,
      unlockTime,
      inputHash,
    });
  } catch (error) {
    if (error instanceof InsufficientFundsError) {
      throw createHttpError(400, 'Insufficient funds');
    }
    logger.error(error);
    throw createHttpError(500, 'Error handling payment credit initialization');
  }
}
