/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { generateBlockchainIdentifier } from '@/utils/generator/blockchain-identifier-generator';
import { SmartContractState } from '@/utils/generator/contract-generator';
import { logger } from '@/utils/logger';
import { serializeAddressObj } from '@meshsdk/core';
import { resolvePaymentKeyHash } from '@meshsdk/core-cst';
import { Network } from '@meshsdk/core';

export type DecodedV1ContractDatum = {
  blockchainIdentifier: string;
  buyerAddress: string;
  sellerAddress: string;
  buyerVkey: string;
  sellerVkey: string;
  state: SmartContractState;
  referenceKey: string;
  referenceSignature: string;
  sellerNonce: string;
  buyerNonce: string;
  collateralReturnLovelace: bigint;
  inputHash: string;
  resultHash: string;
  payByTime: bigint;
  resultTime: bigint;
  unlockTime: bigint;
  externalDisputeUnlockTime: bigint;
  buyerCooldownTime: bigint;
  sellerCooldownTime: bigint;
};

export function decodeV1ContractDatum(
  decodedDatum: any,
  network: Network,
): DecodedV1ContractDatum | null {
  try {
    /*
  buyer: VerificationKeyHash,
  seller: VerificationKeyHash,
  reference_key: ByteArray,
  reference_signature: ByteArray,
  seller_nonce: ByteArray,
  buyer_nonce: ByteArray,
  collateral_return_lovelace: Int,
  input_hash: ByteArray,
  result_hash: ByteArray,
  pay_by_time: POSIXTime,
  submit_result_time: POSIXTime,
  unlock_time: POSIXTime,
  external_dispute_unlock_time: POSIXTime,
  seller_cooldown_time: POSIXTime,
  buyer_cooldown_time: POSIXTime,
  state: State,
*/
    if (decodedDatum == null) {
      //invalid transaction
      return null;
    }
    const fields = decodedDatum.fields;

    if (fields?.length != 16) {
      //invalid transaction
      return null;
    }
    const buyerAddress = serializeAddressObj(
      fields[0],
      network == 'mainnet' ? 1 : 0,
    );
    const buyerVkey = resolvePaymentKeyHash(buyerAddress);

    const sellerAddress = serializeAddressObj(
      fields[1],
      network == 'mainnet' ? 1 : 0,
    );
    const sellerVkey = resolvePaymentKeyHash(sellerAddress);

    if (fields[2] == null || fields[2].bytes == null) {
      //invalid transaction
      return null;
    }

    const referenceKey = fields[2].bytes;

    if (fields[3] == null || fields[3].bytes == null) {
      //invalid transaction
      return null;
    }
    const referenceSignature = fields[3].bytes;

    if (fields[4] == null || fields[4].bytes == null) {
      //invalid transaction
      return null;
    }
    const sellerNonce = fields[4].bytes;

    if (fields[5] == null || fields[5].bytes == null) {
      //invalid transaction
      return null;
    }
    const buyerNonce = fields[5].bytes;

    if (fields[6] == null || fields[6].int == null) {
      //invalid transaction
      return null;
    }
    const collateralReturnLovelace = BigInt(fields[6].int);
    if (fields[7] == null || fields[7].bytes == null) {
      //invalid transaction
      return null;
    }
    const inputHash = fields[7].bytes;
    if (fields[8] == null || fields[8].bytes == null) {
      //invalid transaction
      return null;
    }
    const resultHash = fields[8].bytes;
    if (fields[9] == null || fields[9].int == null) {
      //invalid transaction
      return null;
    }
    const payByTime = BigInt(fields[9].int);
    if (fields[10] == null || fields[10].int == null) {
      //invalid transaction
      return null;
    }
    const resultTime = BigInt(fields[10].int);
    if (fields[11] == null || fields[11].int == null) {
      //invalid transaction
      return null;
    }
    const unlockTime = BigInt(fields[11].int);
    if (fields[12] == null || fields[12].int == null) {
      //invalid transaction
      return null;
    }
    const externalDisputeUnlockTime = BigInt(fields[12].int);

    if (fields[13] == null || fields[13].int == null) {
      //invalid transaction
      return null;
    }
    const sellerCooldownTime = BigInt(fields[13].int);

    if (fields[14] == null || fields[14].int == null) {
      //invalid transaction
      return null;
    }
    const buyerCooldownTime = BigInt(fields[14].int);

    const state = valueToStatus(fields[15]);
    if (state == null) {
      //invalid transaction
      return null;
    }

    if (collateralReturnLovelace < 0n) {
      //invalid transaction
      return null;
    }

    const blockchainIdentifier = generateBlockchainIdentifier(
      referenceKey as string,
      referenceSignature as string,
      sellerNonce as string,
      buyerNonce as string,
    );

    return {
      blockchainIdentifier: blockchainIdentifier,
      buyerAddress: buyerAddress,
      sellerAddress: sellerAddress,
      buyerVkey: buyerVkey,
      sellerVkey: sellerVkey,
      state,
      referenceKey: referenceKey as string,
      referenceSignature: referenceSignature as string,
      sellerNonce: sellerNonce as string,
      buyerNonce: buyerNonce as string,
      collateralReturnLovelace,
      inputHash: inputHash as string,
      resultHash: resultHash as string,
      payByTime,
      resultTime,
      unlockTime,
      externalDisputeUnlockTime,
      buyerCooldownTime,
      sellerCooldownTime,
    };
  } catch (error) {
    logger.warn('Error decoding v1 contract datum', { error: error });
    return null;
  }
}

export function newCooldownTime(cooldownTime: bigint) {
  //We add some additional cooldown time to avoid validity issues with blocktime
  const cooldownTimeMs =
    BigInt(Date.now()) + cooldownTime + BigInt(1000 * 60 * 10);
  return cooldownTimeMs;
}

function valueToStatus(value: any) {
  if (value == null) {
    return null;
  }
  if (
    value.constructor == null ||
    value.fields == null ||
    value.fields.length != 0
  ) {
    return null;
  }
  const constructor = value.constructor;
  switch (constructor) {
    case 0n:
    case 0:
      return SmartContractState.FundsLocked;
    case 1n:
    case 1:
      return SmartContractState.ResultSubmitted;
    case 2n:
    case 2:
      return SmartContractState.RefundRequested;
    case 3n:
    case 3:
      return SmartContractState.Disputed;
  }
  return null;
}
