import { SmartContractState } from '@/utils/generator/contract-generator';
import { logger } from '@/utils/logger';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function decodeV1ContractDatum(decodedDatum: any) {
  try {
    if (decodedDatum == null) {
      //invalid transaction
      return null;
    }
    const fields = decodedDatum.fields;

    if (fields?.length != 10) {
      //invalid transaction
      return null;
    }

    if (fields[0] == null || !fields[0].bytes) {
      //invalid transaction
      return null;
    }
    const buyer = fields[0].bytes;

    if (fields[1] == null || fields[1].bytes == null) {
      //invalid transaction
      return null;
    }
    const seller = fields[1].bytes;

    if (fields[2] == null || fields[2].bytes == null) {
      //invalid transaction
      return null;
    }
    const blockchainIdentifier = Buffer.from(fields[2].bytes, 'hex').toString(
      'utf-8',
    );

    if (fields[3] == null || fields[3].bytes == null) {
      //invalid transaction
      return null;
    }

    // resultHash is stored in contract as a ByteArray
    const resultHash = Buffer.from(fields[3].bytes, 'binary').toString('utf-8');

    if (fields[4] == null || fields[4].int == null) {
      //invalid transaction
      return null;
    }
    if (fields[5] == null || fields[5].int == null) {
      //invalid transaction
      return null;
    }
    if (fields[6] == null || fields[6].int == null) {
      //invalid transaction
      return null;
    }
    const resultTime = parseInt(fields[4].int);
    const unlockTime = parseInt(fields[5].int);
    const externalDisputeUnlockTime = parseInt(fields[6].int);

    if (fields[7] == null || fields[7].int == null) {
      //invalid transaction
      return null;
    }
    const buyerCooldownTime = parseInt(fields[7].int);

    if (fields[8] == null || fields[8].int == null) {
      //invalid transaction
      return null;
    }
    const sellerCooldownTime = parseInt(fields[8].int);

    const state = valueToStatus(fields[9]);
    if (state == null) {
      //invalid transaction
      return null;
    }

    return {
      buyer,
      seller,
      state,
      blockchainIdentifier,
      resultHash,
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
export function newCooldownTime(cooldownTime: number) {
  //We add some additional cooldown time to avoid validity issues with blocktime
  const cooldownTimeMs = Date.now() + cooldownTime + 1000 * 60 * 10;
  return cooldownTimeMs;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function valueToStatus(value: any) {
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
    case 0:
      return SmartContractState.FundsLocked;
    case 1:
      return SmartContractState.ResultSubmitted;
    case 2:
      return SmartContractState.RefundRequested;
    case 3:
      return SmartContractState.Disputed;
  }
  return null;
}

export function valueToBool(value: unknown) {
  if (value == null) {
    return null;
  }
  const val = value as { constructor?: number; fields?: unknown[] };
  if (val.constructor == null || val.fields == null || val.fields.length != 0) {
    return null;
  }
  if (val.constructor === 1) {
    return true;
  }
  if (val.constructor === 0) {
    return false;
  }
  return null;
}
