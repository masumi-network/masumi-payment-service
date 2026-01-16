import { CONSTANTS } from '@/utils/config';
import {
  DecodedV1ContractDatum,
  decodeV1ContractDatum,
} from '@/utils/converter/string-datum-convert';
import { SmartContractState } from '@/utils/generator/contract-generator';
import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import {
  PlutusDatumSchema,
  Transaction,
} from '@emurgo/cardano-serialization-lib-nodejs';
import { deserializeDatum, resolvePaymentKeyHash } from '@meshsdk/core';
import { Network, OnChainState } from '@/generated/prisma/client';
import {
  getSmartContractInteractionTxHistoryList,
  TransactionMetadata,
} from '../blockchain';

export function calculateValueChange(
  inputs: Array<{
    address: string;
    amount: Array<{ unit: string; quantity: string }>;
    tx_hash: string;
    output_index: number;
    data_hash: string | null;
    inline_datum: string | null;
    reference_script_hash: string | null;
    collateral: boolean;
    reference?: boolean;
  }>,
  outputs: Array<{
    address: string;
    amount: Array<{ unit: string; quantity: string }>;
    output_index: number;
    data_hash: string | null;
    inline_datum: string | null;
    collateral: boolean;
    reference_script_hash: string | null;
    consumed_by_tx?: string | null;
  }>,
  vkey: string,
) {
  const withdrawnAmount: Array<{ unit: string; quantity: bigint }> = [];
  const inputAmounts = inputs
    .filter((x) => resolvePaymentKeyHash(x.address) == vkey)
    .map((x) => x.amount);
  const outputAmounts = outputs
    .filter((x) => resolvePaymentKeyHash(x.address) == vkey)
    .map((x) => x.amount);

  outputAmounts.forEach((output) => {
    output.forEach((amount) => {
      const outputAmounts = withdrawnAmount.find((x) => {
        return x.unit == amount.unit;
      });
      if (outputAmounts == null) {
        const amountNumber = BigInt(amount.quantity);
        withdrawnAmount.push({
          unit: amount.unit,
          quantity: amountNumber,
        });
      } else {
        outputAmounts.quantity += BigInt(amount.quantity);
      }
    });
  });
  inputAmounts.forEach((input) => {
    input.forEach((amount) => {
      const withdrawnAmounts = withdrawnAmount.find((x) => {
        return x.unit == amount.unit;
      });
      if (withdrawnAmounts == null) {
        const amountNumber = -BigInt(amount.quantity);
        withdrawnAmount.push({
          unit: amount.unit,
          quantity: amountNumber,
        });
      } else {
        withdrawnAmounts.quantity -= BigInt(amount.quantity);
      }
    });
  });
  return withdrawnAmount;
}

export function checkPaymentAmountsMatch(
  expectedAmounts: Array<{ unit: string; amount: bigint }>,
  actualAmounts: Array<{ unit: string; quantity: string }>,
  collateralReturn: bigint,
) {
  if (collateralReturn < 0n) {
    return false;
  }
  if (
    collateralReturn > 0n &&
    collateralReturn < CONSTANTS.MIN_COLLATERAL_LOVELACE
  ) {
    return false;
  }
  return expectedAmounts.every((x) => {
    if (x.unit.toLowerCase() == 'lovelace') {
      x.unit = '';
    }
    const existingAmount = actualAmounts.find((y) => {
      if (y.unit.toLowerCase() == 'lovelace') {
        y.unit = '';
      }
      return y.unit == x.unit;
    });
    if (existingAmount == null) return false;
    //allow for some overpayment to handle min lovelace requirements
    if (x.unit == '') {
      return x.amount <= BigInt(existingAmount.quantity) - collateralReturn;
    }
    //require exact match for non-lovelace amounts
    return x.amount == BigInt(existingAmount.quantity);
  });
}

export function getCardanoFeesSeller(
  redeemerVersion: number,
  tx: TransactionMetadata,
) {
  if (redeemerVersion == 0) {
    //Withdraw
    return tx.fees;
  } else if (redeemerVersion == 5) {
    //SubmitResult
    return tx.fees;
  } else if (redeemerVersion == 6) {
    //AllowRefund
    return tx.fees;
  }
  return BigInt(0);
}

export function getCardanoFeesBuyer(
  redeemerVersion: number,
  tx: TransactionMetadata,
) {
  if (redeemerVersion == 1) {
    //RequestRefund
    return tx.fees;
  } else if (redeemerVersion == 2) {
    //CancelRefundRequest
    return tx.fees;
  } else if (redeemerVersion == 3) {
    //WithdrawRefund
    return tx.fees;
  } else if (redeemerVersion == 6) {
    //WithdrawDisputed
    return tx.fees;
  }
  return BigInt(0);
}

export function redeemerToOnChainState(
  redeemerVersion: number,
  decodedNewContract: {
    resultHash: string | null;
    state: SmartContractState;
  } | null,
  valueMatches: boolean,
) {
  if (redeemerVersion == 0) {
    //Withdraw
    return OnChainState.Withdrawn;
  } else if (redeemerVersion == 1) {
    //RequestRefund
    if (decodedNewContract?.resultHash && decodedNewContract.resultHash != '') {
      return OnChainState.Disputed;
    } else {
      return OnChainState.RefundRequested;
    }
  } else if (redeemerVersion == 2) {
    //CancelRefundRequest
    if (
      decodedNewContract?.resultHash != null &&
      decodedNewContract?.resultHash != ''
    ) {
      return OnChainState.ResultSubmitted;
    } else {
      //Ensure the amounts match, to prevent state change attacks

      return valueMatches == true
        ? OnChainState.FundsLocked
        : OnChainState.FundsOrDatumInvalid;
    }
  } else if (redeemerVersion == 3) {
    //WithdrawRefund
    return OnChainState.RefundWithdrawn;
  } else if (redeemerVersion == 4) {
    //WithdrawDisputed
    return OnChainState.DisputedWithdrawn;
  } else if (redeemerVersion == 5) {
    //SubmitResult
    if (
      decodedNewContract?.state == SmartContractState.RefundRequested ||
      decodedNewContract?.state == SmartContractState.Disputed
    ) {
      return OnChainState.Disputed;
    } else {
      return OnChainState.ResultSubmitted;
    }
  } else if (redeemerVersion == 6) {
    //AllowRefund
    return OnChainState.RefundRequested;
  } else {
    //invalid transaction
    return null;
  }
}

export type ExtractOnChainTransactionDataOutput =
  | {
      type: 'Initial';
      valueOutputs: Array<{
        address: string;
        amount: Array<{
          unit: string;
          quantity: string;
        }>;
        output_index: number;
        data_hash: string | null;
        inline_datum: string | null;
        collateral: boolean;
        reference_script_hash: string | null;
        consumed_by_tx?: string | null;
      }>;
    }
  | { type: 'Invalid'; error: string }
  | {
      type: 'Transaction';
      valueInputs: Array<{
        address: string;
        amount: Array<{
          unit: string;
          quantity: string;
        }>;
        tx_hash: string;
        output_index: number;
        data_hash: string | null;
        inline_datum: string | null;
        reference_script_hash: string | null;
        collateral: boolean;
        reference?: boolean;
      }>;
      valueOutputs: Array<{
        address: string;
        amount: Array<{
          unit: string;
          quantity: string;
        }>;
        output_index: number;
        data_hash: string | null;
        inline_datum: string | null;
        collateral: boolean;
        reference_script_hash: string | null;
        consumed_by_tx?: string | null;
      }>;
      valueOutput: {
        address: string;
        amount: Array<{
          unit: string;
          quantity: string;
        }>;
      } | null;
      redeemerVersion: number;
      decodedNewContract: DecodedV1ContractDatum | null;
      decodedOldContract: DecodedV1ContractDatum;
    };
export function extractOnChainTransactionData(
  tx: {
    blockTime: number;
    tx: {
      tx_hash: string;
    };
    block: {
      confirmations: number;
    };
    utxos: {
      hash: string;
      inputs: Array<{
        address: string;
        amount: Array<{
          unit: string;
          quantity: string;
        }>;
        tx_hash: string;
        output_index: number;
        data_hash: string | null;
        inline_datum: string | null;
        reference_script_hash: string | null;
        collateral: boolean;
        reference?: boolean;
      }>;
      outputs: Array<{
        address: string;
        amount: Array<{
          unit: string;
          quantity: string;
        }>;
        output_index: number;
        data_hash: string | null;
        inline_datum: string | null;
        collateral: boolean;
        reference_script_hash: string | null;
        consumed_by_tx?: string | null;
      }>;
    };
    transaction: Transaction;
  },
  paymentContract: { smartContractAddress: string; network: Network },
): ExtractOnChainTransactionDataOutput {
  const valueInputs = tx.utxos.inputs.filter((x) => {
    return x.address == paymentContract.smartContractAddress;
  });
  const valueOutputs = tx.utxos.outputs.filter((x) => {
    return x.address == paymentContract.smartContractAddress;
  });
  if (valueOutputs.find((output) => output.reference_script_hash != null)) {
    return {
      type: 'Invalid',
      error: 'Smart Contract value output has reference script set',
    };
  }
  const redeemers = tx.transaction.witness_set().redeemers();
  //TODO: We need to fix the redeemer check to support other smart contracts
  if (valueInputs.length == 0 && !redeemers)
    return { type: 'Initial', valueOutputs };
  if (valueInputs.length != 1)
    return {
      type: 'Invalid',
      error: 'Smart Contract value input invalid length (bigger than 0) ',
    };
  if (!redeemers) {
    return {
      type: 'Invalid',
      error: 'Smart Contract redeemer invalid',
    };
  }
  if (redeemers.len() != 1) {
    return {
      type: 'Invalid',
      error:
        'Smart Contract redeemer invalid length: ' +
        redeemers.len().toString() +
        ' (expected 1)',
    };
  }
  const valueInput = valueInputs[0];
  if (valueInput.reference_script_hash)
    return {
      type: 'Invalid',
      error: 'Smart Contract value input has reference script set',
    };
  const inputDatum = valueInput.inline_datum;
  if (inputDatum == null) {
    return {
      type: 'Invalid',
      error: 'Smart Contract value input has no datum',
    };
  }

  const decodedInputDatum: unknown = deserializeDatum(inputDatum);
  const decodedOldContract = decodeV1ContractDatum(
    decodedInputDatum,
    paymentContract.network == Network.Mainnet ? 'mainnet' : 'preprod',
  );
  if (decodedOldContract == null) {
    return {
      type: 'Invalid',
      error: 'Smart Contract value input has no datum',
    };
  }

  if (valueOutputs.length > 1) {
    return {
      type: 'Invalid',
      error: 'Smart Contract value output invalid length (bigger than 0) ',
    };
  }
  const valueOutput = valueOutputs.length == 1 ? valueOutputs[0] : null;

  const outputDatum = valueOutput?.inline_datum ?? null;
  const decodedOutputDatum: unknown =
    outputDatum != null ? deserializeDatum(outputDatum) : null;
  const decodedNewContract = decodeV1ContractDatum(
    decodedOutputDatum,
    paymentContract.network == Network.Mainnet ? 'mainnet' : 'preprod',
  );

  const redeemer = redeemers.get(0);
  const redeemerJson = redeemer
    .data()
    .to_json(PlutusDatumSchema.BasicConversions);
  const redeemerJsonObject = JSON.parse(redeemerJson) as {
    constructor: number;
  };
  const redeemerVersion = redeemerJsonObject.constructor;

  if (
    redeemerVersion != 0 &&
    redeemerVersion != 3 &&
    redeemerVersion != 4 &&
    decodedNewContract == null
  ) {
    return {
      type: 'Invalid',
      error: 'Possible invalid state in smart contract detected',
    };
  }

  return {
    type: 'Transaction',
    valueInputs,
    valueOutputs,
    valueOutput,
    redeemerVersion,
    decodedNewContract,
    decodedOldContract,
  };
}

export async function checkIfTxIsInHistory(
  currentTxHash: string | undefined,
  transactionHistory: Array<{
    txHash: string | null;
  }>,
  blockfrost: BlockFrostAPI,
  smartContractAddress: string,
  tx: {
    blockTime: number;
    tx: { tx_hash: string };
    block: { confirmations: number };
    utxos: {
      hash: string;
      inputs: Array<{
        address: string;
        amount: Array<{ unit: string; quantity: string }>;
        tx_hash: string;
        output_index: number;
        data_hash: string | null;
        inline_datum: string | null;
        reference_script_hash: string | null;
        collateral: boolean;
        reference?: boolean;
      }>;
      outputs: Array<{
        address: string;
        amount: Array<{ unit: string; quantity: string }>;
        output_index: number;
        data_hash: string | null;
        inline_datum: string | null;
        collateral: boolean;
        reference_script_hash: string | null;
        consumed_by_tx?: string | null;
      }>;
    };
    transaction: Transaction;
  },
) {
  if (currentTxHash == tx.tx.tx_hash) {
    return true;
  }
  const txHistory = await getSmartContractInteractionTxHistoryList(
    blockfrost,
    smartContractAddress,
    tx.tx.tx_hash,
    currentTxHash ?? 'no-tx',
  );
  //find tx hash in history
  for (const txHash of txHistory) {
    if (
      currentTxHash == txHash ||
      transactionHistory.find((x) => x.txHash == txHash) != null
    ) {
      return true;
    }
  }

  return false;
}
