import { prisma } from '@/utils/db';
import { SmartContractState } from '@/utils/generator/contract-generator';
import { logger } from '@/utils/logger';
import {
  convertNewPaymentActionAndError,
  convertNewPurchasingActionAndError,
} from '@/utils/logic/state-transitions';
import { Transaction } from '@emurgo/cardano-serialization-lib-nodejs';
import {
  Network,
  OnChainState,
  PaymentAction,
  PaymentErrorType,
  PaymentSource,
  Prisma,
  PurchaseErrorType,
  PurchasingAction,
  TransactionStatus,
  WalletType,
} from '@prisma/client';
import {
  calculateValueChange,
  checkIfTxIsInHistory,
  checkPaymentAmountsMatch,
  redeemerToOnChainState,
} from '../util';
import { deserializeDatum } from '@meshsdk/core';
import { decodeV1ContractDatum } from '@/utils/converter/string-datum-convert';
import { BlockFrostAPI } from '@blockfrost/blockfrost-js';

export async function handlePaymentTransactionCardanoV1(
  tx_hash: string,
  newState: OnChainState,
  paymentContractId: string,
  blockchainIdentifier: string,
  resultHash: string,
  currentAction: PaymentAction,
  buyerCooldownTime: number,
  sellerCooldownTime: number,
  sellerWithdrawn: Array<{ unit: string; quantity: bigint }>,
  buyerWithdrawn: Array<{ unit: string; quantity: bigint }>,
) {
  await prisma.$transaction(
    async (prisma) => {
      //we dont need to do sanity checks as the tx hash is unique
      const paymentRequest = await prisma.paymentRequest.findUnique({
        where: {
          paymentSourceId: paymentContractId,
          blockchainIdentifier: blockchainIdentifier,
        },
        include: {
          CurrentTransaction: { include: { BlocksWallet: true } },
        },
      });

      if (paymentRequest == null) {
        //transaction is not registered with us or a payment transaction
        return;
      }

      const newAction = convertNewPaymentActionAndError(
        currentAction,
        newState,
      );

      await prisma.paymentRequest.update({
        where: { id: paymentRequest.id },
        data: {
          NextAction: {
            create: {
              requestedAction: newAction.action,
              errorNote: newAction.errorNote,
              errorType: newAction.errorType,
            },
          },
          TransactionHistory:
            paymentRequest.currentTransactionId != null
              ? { connect: { id: paymentRequest.currentTransactionId } }
              : undefined,
          CurrentTransaction: {
            create: {
              txHash: tx_hash,
              status: TransactionStatus.Confirmed,
            },
          },
          WithdrawnForSeller: sellerWithdrawn
            ? {
                createMany: {
                  data: sellerWithdrawn.map((sw) => {
                    return { unit: sw.unit, amount: sw.quantity };
                  }),
                },
              }
            : undefined,
          WithdrawnForBuyer: buyerWithdrawn
            ? {
                createMany: {
                  data: buyerWithdrawn.map((bw) => {
                    return { unit: bw.unit, amount: bw.quantity };
                  }),
                },
              }
            : undefined,
          buyerCoolDownTime: buyerCooldownTime,
          sellerCoolDownTime: sellerCooldownTime,
          onChainState: newState,
          resultHash: resultHash,
        },
      });
      if (
        paymentRequest.currentTransactionId != null &&
        paymentRequest.CurrentTransaction?.BlocksWallet != null
      ) {
        await prisma.transaction.update({
          where: {
            id: paymentRequest.currentTransactionId,
          },
          data: { BlocksWallet: { disconnect: true } },
        });
        await prisma.hotWallet.update({
          where: {
            id: paymentRequest.CurrentTransaction.BlocksWallet.id,
            deletedAt: null,
          },
          data: { lockedAt: null },
        });
      }
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      timeout: 100000,
      maxWait: 10000,
    },
  );
}

export async function handlePurchasingTransactionCardanoV1(
  tx_hash: string,
  newStatus: OnChainState,
  paymentContractId: string,
  blockchainIdentifier: string,
  resultHash: string,
  currentAction: PurchasingAction,
  buyerCooldownTime: number,
  sellerCooldownTime: number,
  sellerWithdrawn: Array<{ unit: string; quantity: bigint }>,
  buyerWithdrawn: Array<{ unit: string; quantity: bigint }>,
) {
  await prisma.$transaction(
    async (prisma) => {
      //we dont need to do sanity checks as the tx hash is unique
      const purchasingRequest = await prisma.purchaseRequest.findUnique({
        where: {
          paymentSourceId: paymentContractId,
          blockchainIdentifier: blockchainIdentifier,
        },
        include: {
          CurrentTransaction: { include: { BlocksWallet: true } },
        },
      });

      if (purchasingRequest == null) {
        //transaction is not registered with us as a purchasing transaction
        return;
      }
      const newAction = convertNewPurchasingActionAndError(
        currentAction,
        newStatus,
      );

      await prisma.purchaseRequest.update({
        where: { id: purchasingRequest.id },
        data: {
          inputHash: purchasingRequest.inputHash,
          NextAction: {
            create: {
              inputHash: purchasingRequest.inputHash,
              requestedAction: newAction.action,
              errorNote: newAction.errorNote,
              errorType: newAction.errorType,
            },
          },
          TransactionHistory:
            purchasingRequest.currentTransactionId != null
              ? { connect: { id: purchasingRequest.currentTransactionId } }
              : undefined,
          CurrentTransaction: {
            create: {
              txHash: tx_hash,
              status: TransactionStatus.Confirmed,
            },
          },
          WithdrawnForSeller: sellerWithdrawn
            ? {
                createMany: {
                  data: sellerWithdrawn.map((sw) => {
                    return { unit: sw.unit, amount: sw.quantity };
                  }),
                },
              }
            : undefined,
          WithdrawnForBuyer: buyerWithdrawn
            ? {
                createMany: {
                  data: buyerWithdrawn.map((bw) => {
                    return { unit: bw.unit, amount: bw.quantity };
                  }),
                },
              }
            : undefined,
          buyerCoolDownTime: buyerCooldownTime,
          sellerCoolDownTime: sellerCooldownTime,
          onChainState: newStatus,
          resultHash: resultHash,
        },
      });
      if (
        purchasingRequest.currentTransactionId != null &&
        purchasingRequest.CurrentTransaction?.BlocksWallet != null
      ) {
        await prisma.transaction.update({
          where: {
            id: purchasingRequest.currentTransactionId,
          },
          data: { BlocksWallet: { disconnect: true } },
        });
        await prisma.hotWallet.update({
          where: {
            id: purchasingRequest.CurrentTransaction.BlocksWallet.id,
            deletedAt: null,
          },
          data: { lockedAt: null },
        });
      }
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      timeout: 10000,
      maxWait: 10000,
    },
  );
}

export async function updateRolledBackTransaction(
  rolledBackTx: Array<{ tx_hash: string }>,
) {
  for (const tx of rolledBackTx) {
    const foundTransaction = await prisma.transaction.findMany({
      where: {
        txHash: tx.tx_hash,
      },
      include: {
        PaymentRequestCurrent: true,
        PaymentRequestHistory: true,
        PurchaseRequestCurrent: true,
        PurchaseRequestHistory: true,
        BlocksWallet: true,
      },
    });
    for (const transaction of foundTransaction) {
      await prisma.transaction.update({
        where: { id: transaction.id },
        data: {
          status: TransactionStatus.RolledBack,
          BlocksWallet: transaction.BlocksWallet
            ? { disconnect: true }
            : undefined,
        },
      });
      if (transaction.BlocksWallet != null) {
        await prisma.hotWallet.update({
          where: { id: transaction.BlocksWallet.id },
          data: {
            lockedAt: null,
          },
        });
      }

      //TODO: automatically resync the transaction
      if (
        transaction.PaymentRequestCurrent ||
        transaction.PaymentRequestHistory
      ) {
        await prisma.paymentRequest.update({
          where: {
            id:
              transaction.PaymentRequestCurrent?.id ??
              transaction.PaymentRequestHistory!.id,
          },
          data: {
            NextAction: {
              upsert: {
                update: {
                  requestedAction: PaymentAction.WaitingForManualAction,
                  errorNote:
                    'Rolled back transaction detected. Please check the transaction and manually resolve the issue.',
                  errorType: PaymentErrorType.Unknown,
                },
                create: {
                  requestedAction: PaymentAction.WaitingForManualAction,
                  errorNote:
                    'Rolled back transaction detected. Please check the transaction and manually resolve the issue.',
                  errorType: PaymentErrorType.Unknown,
                },
              },
            },
          },
        });
      }
      if (
        transaction.PurchaseRequestCurrent ||
        transaction.PurchaseRequestHistory
      ) {
        await prisma.purchaseRequest.update({
          where: {
            id:
              transaction.PurchaseRequestCurrent?.id ??
              transaction.PurchaseRequestHistory!.id,
          },
          data: {
            NextAction: {
              upsert: {
                update: {
                  requestedAction: PurchasingAction.WaitingForManualAction,
                  errorNote:
                    'Rolled back transaction detected. Please check the transaction and manually resolve the issue.',
                  errorType: PurchaseErrorType.Unknown,
                },
                create: {
                  requestedAction: PurchasingAction.WaitingForManualAction,
                  errorNote:
                    'Rolled back transaction detected. Please check the transaction and manually resolve the issue.',
                  errorType: PurchaseErrorType.Unknown,
                  inputHash:
                    transaction.PurchaseRequestCurrent?.inputHash ??
                    transaction.PurchaseRequestHistory!.inputHash,
                },
              },
            },
          },
        });
      }
    }
  }
}
export async function updateInitialTransactions(
  valueOutputs: Array<{
    address: string;
    amount: Array<{ unit: string; quantity: string }>;
    output_index: number;
    data_hash: string | null;
    inline_datum: string | null;
    collateral: boolean;
    reference_script_hash: string | null;
    consumed_by_tx?: string | null;
  }>,
  paymentContract: {
    id: string;
    network: Network;
  },
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
  for (const output of valueOutputs) {
    const outputDatum = output.inline_datum;
    if (outputDatum == null) {
      //invalid transaction
      continue;
    }
    const decodedOutputDatum: unknown = deserializeDatum(outputDatum);
    const decodedNewContract = decodeV1ContractDatum(
      decodedOutputDatum,
      paymentContract.network == Network.Mainnet ? 'mainnet' : 'preprod',
    );
    if (decodedNewContract == null) {
      //invalid transaction
      continue;
    }

    await updateInitialPurchaseTransaction(
      paymentContract,
      decodedNewContract,
      output,
      tx,
    );

    await updateInitialPaymentTransaction(
      decodedNewContract,
      paymentContract,
      tx,
      output,
    );
  }
}
export async function updateInitialPurchaseTransaction(
  paymentContract: { id: string; network: Network },
  decodedNewContract: {
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
  },
  output: {
    address: string;
    amount: Array<{ unit: string; quantity: string }>;
    output_index: number;
    data_hash: string | null;
    inline_datum: string | null;
    collateral: boolean;
    reference_script_hash: string | null;
    consumed_by_tx?: string | null;
  },
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
  await prisma.$transaction(
    async (prisma) => {
      const sellerWallet = await prisma.walletBase.findUnique({
        where: {
          paymentSourceId_walletVkey_walletAddress_type: {
            paymentSourceId: paymentContract.id,
            walletVkey: decodedNewContract.sellerVkey,
            walletAddress: decodedNewContract.sellerAddress,
            type: WalletType.Seller,
          },
        },
      });
      if (sellerWallet == null) {
        return;
      }

      const dbEntry = await prisma.purchaseRequest.findUnique({
        where: {
          blockchainIdentifier: decodedNewContract.blockchainIdentifier,
          paymentSourceId: paymentContract.id,
          NextAction: {
            requestedAction: PurchasingAction.FundsLockingInitiated,
          },
        },
        include: {
          SmartContractWallet: { where: { deletedAt: null } },
          SellerWallet: true,
          CurrentTransaction: {
            include: { BlocksWallet: true },
          },
        },
      });
      if (dbEntry == null) {
        //transaction is not registered with us
        return;
      }
      if (dbEntry.SmartContractWallet == null) {
        logger.error(
          'No smart contract wallet set for purchase request in db',
          { purchaseRequest: dbEntry },
        );
        await prisma.purchaseRequest.update({
          where: { id: dbEntry.id },
          data: {
            NextAction: {
              create: {
                requestedAction: PurchasingAction.WaitingForManualAction,
                errorNote:
                  'No smart contract wallet set for purchase request in db. This is likely an internal error.',
                errorType: PurchaseErrorType.Unknown,
                inputHash: decodedNewContract.inputHash,
              },
            },
          },
        });
        return;
      }

      if (dbEntry.SellerWallet == null) {
        logger.error(
          'No seller wallet set for purchase request in db. This seems like an internal error.',
          { purchaseRequest: dbEntry },
        );
        await prisma.purchaseRequest.update({
          where: { id: dbEntry.id },
          data: {
            NextAction: {
              create: {
                requestedAction: PurchasingAction.WaitingForManualAction,
                errorNote:
                  'No seller wallet set for purchase request in db. This seems like an internal error.',
                errorType: PurchaseErrorType.Unknown,
                inputHash: decodedNewContract.inputHash,
              },
            },
          },
        });
        return;
      }
      if (output.reference_script_hash != null) {
        //no reference script allowed
        logger.warn(
          'Reference script hash is not null, this should not be set',
          { tx: tx.tx.tx_hash },
        );
        return;
      }

      //We soft ignore those transactions
      if (
        decodedNewContract.sellerVkey != dbEntry.SellerWallet.walletVkey ||
        decodedNewContract.sellerAddress != dbEntry.SellerWallet.walletAddress
      ) {
        logger.warn(
          'Seller does not match seller in db. This likely is a spoofing attempt.',
          {
            purchaseRequest: dbEntry,
            sender: decodedNewContract.sellerVkey,
            senderAddress: decodedNewContract.sellerAddress,
            senderDb: dbEntry.SmartContractWallet?.walletVkey,
            senderDbAddress: dbEntry.SmartContractWallet?.walletAddress,
          },
        );
        return;
      }
      if (
        tx.utxos.inputs.find(
          (x) => x.address == decodedNewContract.buyerAddress,
        ) == null
      ) {
        logger.warn(
          'Buyer address not found in inputs, this likely is a spoofing attempt.',
          {
            purchaseRequest: dbEntry,
            buyerAddress: decodedNewContract.buyerAddress,
          },
        );
        return;
      }

      if (
        BigInt(decodedNewContract.collateralReturnLovelace) !=
        dbEntry.collateralReturnLovelace
      ) {
        logger.warn(
          'Collateral return lovelace does not match collateral return lovelace in db. This likely is a spoofing attempt.',
          {
            purchaseRequest: dbEntry,
            collateralReturnLovelace:
              decodedNewContract.collateralReturnLovelace,
            collateralReturnLovelaceDb: dbEntry.collateralReturnLovelace,
          },
        );
        return;
      }

      if (BigInt(decodedNewContract.payByTime) != dbEntry.payByTime) {
        logger.warn(
          'Pay by time does not match pay by time in db. This likely is a spoofing attempt.',
          { purchaseRequest: dbEntry },
        );
        return;
      }

      const blockTime = tx.blockTime;
      if (blockTime * 1000 > decodedNewContract.payByTime) {
        logger.warn(
          'Block time is after pay by time. This is a timed out purchase.',
          {
            purchaseRequest: dbEntry,
            blockTime: blockTime * 1000,
            payByTime: decodedNewContract.payByTime,
          },
        );
        return;
      }

      if (
        decodedNewContract.buyerVkey !=
          dbEntry.SmartContractWallet.walletVkey ||
        decodedNewContract.buyerAddress !=
          dbEntry.SmartContractWallet.walletAddress
      ) {
        logger.warn(
          'Buyer does not match buyer in db. This likely is a spoofing attempt.',
          {
            purchaseRequest: dbEntry,
            buyer: decodedNewContract.buyerVkey,
            buyerAddress: decodedNewContract.buyerAddress,
            buyerDb: dbEntry.SmartContractWallet?.walletVkey,
            buyerDbAddress: dbEntry.SmartContractWallet?.walletAddress,
          },
        );
        return;
      }
      if (
        decodedNewContract.state == SmartContractState.RefundRequested ||
        decodedNewContract.state == SmartContractState.Disputed
      ) {
        logger.warn(
          'Refund was requested. This likely is a spoofing attempt.',
          {
            purchaseRequest: dbEntry,
            state: decodedNewContract.state,
          },
        );
        return;
      }
      if (decodedNewContract.resultHash != '') {
        logger.warn('Result hash was set. This likely is a spoofing attempt.', {
          purchaseRequest: dbEntry,
          resultHash: decodedNewContract.resultHash,
        });
        return;
      }
      if (BigInt(decodedNewContract.resultTime) != dbEntry.submitResultTime) {
        logger.warn(
          'Result time is not the agreed upon time. This likely is a spoofing attempt.',
          {
            purchaseRequest: dbEntry,
            resultTime: decodedNewContract.resultTime,
            resultTimeDb: dbEntry.submitResultTime,
          },
        );
        return;
      }
      if (decodedNewContract.unlockTime < dbEntry.unlockTime) {
        logger.warn(
          'Unlock time is before the agreed upon time. This likely is a spoofing attempt.',
          {
            purchaseRequest: dbEntry,
            unlockTime: decodedNewContract.unlockTime,
            unlockTimeDb: dbEntry.unlockTime,
          },
        );
        return;
      }
      if (
        BigInt(decodedNewContract.externalDisputeUnlockTime) !=
        dbEntry.externalDisputeUnlockTime
      ) {
        logger.warn(
          'External dispute unlock time is not the agreed upon time. This likely is a spoofing attempt.',
          {
            purchaseRequest: dbEntry,
            externalDisputeUnlockTime:
              decodedNewContract.externalDisputeUnlockTime,
            externalDisputeUnlockTimeDb: dbEntry.externalDisputeUnlockTime,
          },
        );
        return;
      }
      if (BigInt(decodedNewContract.buyerCooldownTime) != BigInt(0)) {
        logger.warn(
          'Buyer cooldown time is not 0. This likely is a spoofing attempt.',
          {
            purchaseRequest: dbEntry,
            buyerCooldownTime: decodedNewContract.buyerCooldownTime,
          },
        );
        return;
      }
      if (BigInt(decodedNewContract.sellerCooldownTime) != BigInt(0)) {
        logger.warn(
          'Seller cooldown time is not 0. This likely is a spoofing attempt.',
          {
            purchaseRequest: dbEntry,
            sellerCooldownTime: decodedNewContract.sellerCooldownTime,
          },
        );
        return;
      }
      //TODO: optional check amounts
      await prisma.purchaseRequest.update({
        where: { id: dbEntry.id },
        data: {
          inputHash: decodedNewContract.inputHash,
          NextAction: {
            create: {
              inputHash: decodedNewContract.inputHash,
              requestedAction: PurchasingAction.WaitingForExternalAction,
            },
          },
          TransactionHistory:
            dbEntry.currentTransactionId != null
              ? {
                  connect: { id: dbEntry.currentTransactionId },
                }
              : undefined,
          CurrentTransaction: {
            create: {
              txHash: tx.tx.tx_hash,
              status: TransactionStatus.Confirmed,
            },
          },
          onChainState: OnChainState.FundsLocked,
          resultHash: decodedNewContract.resultHash,
        },
      });
      if (
        dbEntry.currentTransactionId != null &&
        dbEntry.CurrentTransaction?.BlocksWallet != null
      ) {
        await prisma.transaction.update({
          where: {
            id: dbEntry.currentTransactionId,
          },
          data: {
            BlocksWallet: { disconnect: true },
          },
        });
        await prisma.hotWallet.update({
          where: {
            id: dbEntry.SmartContractWallet.id,
            deletedAt: null,
          },
          data: {
            lockedAt: null,
          },
        });
      }
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      timeout: 15000,
      maxWait: 15000,
    },
  );
}

export async function updateInitialPaymentTransaction(
  decodedNewContract: {
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
  },
  paymentContract: { id: string; network: Network },
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
  output: {
    address: string;
    amount: Array<{ unit: string; quantity: string }>;
    output_index: number;
    data_hash: string | null;
    inline_datum: string | null;
    collateral: boolean;
    reference_script_hash: string | null;
    consumed_by_tx?: string | null;
  },
) {
  await prisma.$transaction(
    async (prisma) => {
      const dbEntry = await prisma.paymentRequest.findUnique({
        where: {
          blockchainIdentifier: decodedNewContract.blockchainIdentifier,
          paymentSourceId: paymentContract.id,
          BuyerWallet: null,
          NextAction: {
            requestedAction: PaymentAction.WaitingForExternalAction,
          },
        },
        include: {
          RequestedFunds: true,
          BuyerWallet: true,
          SmartContractWallet: { where: { deletedAt: null } },
          CurrentTransaction: {
            include: { BlocksWallet: true },
          },
        },
      });
      if (dbEntry == null) {
        //transaction is not registered with us or duplicated (therefore invalid)
        return;
      }
      if (dbEntry.BuyerWallet != null) {
        logger.error(
          'Existing buyer set for payment request in db. This is likely an internal error.',
          { paymentRequest: dbEntry },
        );
        await prisma.paymentRequest.update({
          where: { id: dbEntry.id },
          data: {
            NextAction: {
              create: {
                requestedAction: PaymentAction.WaitingForManualAction,
                errorNote:
                  'Existing buyer set for payment request in db. This is likely an internal error.',
                errorType: PaymentErrorType.Unknown,
              },
            },
          },
        });
        return;
      }
      if (dbEntry.SmartContractWallet == null) {
        logger.error(
          'No smart contract wallet set for payment request in db. This is likely an internal error.',
          { paymentRequest: dbEntry },
        );
        await prisma.paymentRequest.update({
          where: { id: dbEntry.id },
          data: {
            NextAction: {
              create: {
                requestedAction: PaymentAction.WaitingForManualAction,
                errorNote:
                  'No smart contract wallet set for payment request in db. This is likely an internal error.',
                errorType: PaymentErrorType.Unknown,
              },
            },
          },
        });
        return;
      }

      let newAction: PaymentAction = PaymentAction.WaitingForExternalAction;
      let newState: OnChainState = OnChainState.FundsLocked;
      const errorNote: string[] = [];
      if (
        tx.utxos.inputs.find(
          (x) => x.address == decodedNewContract.buyerAddress,
        ) == null
      ) {
        logger.warn(
          'Buyer address not found in inputs, this likely is a spoofing attempt.',
          {
            paymentRequest: dbEntry,
            buyerAddress: decodedNewContract.buyerAddress,
          },
        );
        return;
      }
      if (BigInt(decodedNewContract.payByTime) != dbEntry.payByTime) {
        const errorMessage =
          'Pay by time does not match pay by time in db. This likely is a spoofing attempt.';
        logger.warn(errorMessage, {
          paymentRequest: dbEntry,
          payByTime: decodedNewContract.payByTime,
          payByTimeDb: dbEntry.payByTime,
        });
        newAction = PaymentAction.WaitingForManualAction;
        newState = OnChainState.FundsOrDatumInvalid;
        errorNote.push(errorMessage);
      }
      const blockTime = tx.blockTime;
      if (blockTime * 1000 > decodedNewContract.payByTime) {
        const errorMessage =
          'Block time is after pay by time. This is a timed out purchase.';
        logger.warn(errorMessage, {
          paymentRequest: dbEntry,
          blockTime: blockTime * 1000,
          payByTime: decodedNewContract.payByTime,
        });
        newAction = PaymentAction.WaitingForManualAction;
        newState = OnChainState.FundsOrDatumInvalid;
        errorNote.push(errorMessage);
      }

      if (output.reference_script_hash != null) {
        const errorMessage =
          'Reference script hash is not null. This likely is a spoofing attempt.';
        logger.warn(errorMessage, { tx: tx.tx.tx_hash });
        newAction = PaymentAction.WaitingForManualAction;
        newState = OnChainState.FundsOrDatumInvalid;
        errorNote.push(errorMessage);
      }
      if (
        decodedNewContract.sellerVkey !=
          dbEntry.SmartContractWallet.walletVkey ||
        decodedNewContract.sellerAddress !=
          dbEntry.SmartContractWallet.walletAddress
      ) {
        const errorMessage =
          'Seller does not match seller in db. This likely is a spoofing attempt.';
        logger.warn(errorMessage, {
          paymentRequest: dbEntry,
          seller: decodedNewContract.sellerVkey,
          sellerAddress: decodedNewContract.sellerAddress,
          sellerDb: dbEntry.SmartContractWallet?.walletVkey,
          sellerDbAddress: dbEntry.SmartContractWallet?.walletAddress,
        });
        newAction = PaymentAction.WaitingForManualAction;
        newState = OnChainState.FundsOrDatumInvalid;
        errorNote.push(errorMessage);
      }
      if (
        decodedNewContract.state == SmartContractState.RefundRequested ||
        decodedNewContract.state == SmartContractState.Disputed
      ) {
        const errorMessage =
          'Refund was requested. This likely is a spoofing attempt.';
        logger.warn(errorMessage, {
          paymentRequest: dbEntry,
          state: decodedNewContract.state,
        });
        newAction = PaymentAction.WaitingForManualAction;
        newState = OnChainState.FundsOrDatumInvalid;
        errorNote.push(errorMessage);
      }
      if (decodedNewContract.resultHash != '') {
        const errorMessage =
          'Result hash was set. This likely is a spoofing attempt.';
        logger.warn(errorMessage, {
          paymentRequest: dbEntry,
          resultHash: decodedNewContract.resultHash,
        });
        newAction = PaymentAction.WaitingForManualAction;
        newState = OnChainState.FundsOrDatumInvalid;
        errorNote.push(errorMessage);
      }
      if (BigInt(decodedNewContract.resultTime) != dbEntry.submitResultTime) {
        const errorMessage =
          'Result time is not the agreed upon time. This likely is a spoofing attempt.';
        logger.warn(errorMessage, {
          paymentRequest: dbEntry,
          resultTime: decodedNewContract.resultTime,
          resultTimeDb: dbEntry.submitResultTime,
        });
        newAction = PaymentAction.WaitingForManualAction;
        newState = OnChainState.FundsOrDatumInvalid;
        errorNote.push(errorMessage);
      }
      if (BigInt(decodedNewContract.unlockTime) != dbEntry.unlockTime) {
        const errorMessage =
          'Unlock time is before the agreed upon time. This likely is a spoofing attempt.';
        logger.warn(errorMessage, {
          paymentRequest: dbEntry,
          unlockTime: decodedNewContract.unlockTime,
          unlockTimeDb: dbEntry.unlockTime,
        });
        newAction = PaymentAction.WaitingForManualAction;
        newState = OnChainState.FundsOrDatumInvalid;
        errorNote.push(errorMessage);
      }
      if (
        BigInt(decodedNewContract.externalDisputeUnlockTime) !=
        dbEntry.externalDisputeUnlockTime
      ) {
        const errorMessage =
          'External dispute unlock time is not the agreed upon time. This likely is a spoofing attempt.';
        logger.warn(errorMessage, {
          paymentRequest: dbEntry,
          externalDisputeUnlockTime:
            decodedNewContract.externalDisputeUnlockTime,
          externalDisputeUnlockTimeDb: dbEntry.externalDisputeUnlockTime,
        });
        newAction = PaymentAction.WaitingForManualAction;
        newState = OnChainState.FundsOrDatumInvalid;
        errorNote.push(errorMessage);
      }
      if (BigInt(decodedNewContract.buyerCooldownTime) != BigInt(0)) {
        const errorMessage =
          'Buyer cooldown time is not 0. This likely is a spoofing attempt.';
        logger.warn(errorMessage, {
          paymentRequest: dbEntry,
          buyerCooldownTime: decodedNewContract.buyerCooldownTime,
        });
        newAction = PaymentAction.WaitingForManualAction;
        newState = OnChainState.FundsOrDatumInvalid;
        errorNote.push(errorMessage);
      }
      if (BigInt(decodedNewContract.sellerCooldownTime) != BigInt(0)) {
        const errorMessage =
          'Seller cooldown time is not 0. This likely is a spoofing attempt.';
        logger.warn(errorMessage, {
          paymentRequest: dbEntry,
          sellerCooldownTime: decodedNewContract.sellerCooldownTime,
        });
        newAction = PaymentAction.WaitingForManualAction;
        newState = OnChainState.FundsOrDatumInvalid;
        errorNote.push(errorMessage);
      }

      const valueMatches = checkPaymentAmountsMatch(
        dbEntry.RequestedFunds,
        output.amount,
        decodedNewContract.collateralReturnLovelace,
      );
      if (valueMatches == false) {
        const errorMessage =
          'Payment amounts do not match. This likely is a spoofing attempt.';
        logger.warn(errorMessage, {
          paymentRequest: dbEntry,
          amounts: output.amount,
          amountsDb: dbEntry.RequestedFunds,
        });
        newAction = PaymentAction.WaitingForManualAction;
        newState = OnChainState.FundsOrDatumInvalid;
        errorNote.push(errorMessage);
      }
      const paymentCountMatches =
        dbEntry.RequestedFunds.filter((x) => x.unit != '').length ==
        output.amount.filter((x) => x.unit != '').length;
      if (paymentCountMatches == false) {
        const errorMessage =
          'Token counts do not match. This likely is a spoofing attempt.';
        logger.warn(errorMessage, {
          paymentRequest: dbEntry,
          amounts: output.amount,
          amountsDb: dbEntry.RequestedFunds,
        });
        newAction = PaymentAction.WaitingForManualAction;
        newState = OnChainState.FundsOrDatumInvalid;
        errorNote.push(errorMessage);
      }

      await prisma.paymentRequest.update({
        where: { id: dbEntry.id },
        data: {
          collateralReturnLovelace: decodedNewContract.collateralReturnLovelace,
          NextAction: {
            create: {
              requestedAction: newAction,
              errorNote:
                errorNote.length > 0 ? errorNote.join(';\n ') : undefined,
            },
          },
          TransactionHistory:
            dbEntry.currentTransactionId != null
              ? {
                  connect: { id: dbEntry.currentTransactionId },
                }
              : undefined,
          CurrentTransaction: {
            create: {
              txHash: tx.tx.tx_hash,
              status: TransactionStatus.Confirmed,
            },
          },
          onChainState: newState,
          resultHash: decodedNewContract.resultHash,
          BuyerWallet: {
            connectOrCreate: {
              where: {
                paymentSourceId_walletVkey_walletAddress_type: {
                  paymentSourceId: paymentContract.id,
                  walletVkey: decodedNewContract.buyerVkey,
                  walletAddress: decodedNewContract.buyerAddress,
                  type: WalletType.Buyer,
                },
              },
              create: {
                walletVkey: decodedNewContract.buyerVkey,
                walletAddress: decodedNewContract.buyerAddress,
                type: WalletType.Buyer,
                PaymentSource: {
                  connect: { id: paymentContract.id },
                },
              },
            },
          },
          //no wallet was locked, we do not need to unlock it
        },
      });
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      timeout: 15000,
      maxWait: 15000,
    },
  );
}

export async function updateTransaction(
  paymentContract: PaymentSource,
  extractedData: {
    type: 'Transaction';
    valueInputs: Array<{
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
    valueOutputs: Array<{
      address: string;
      amount: Array<{ unit: string; quantity: string }>;
      output_index: number;
      data_hash: string | null;
      inline_datum: string | null;
      collateral: boolean;
      reference_script_hash: string | null;
      consumed_by_tx?: string | null;
    }>;
    valueOutput: {
      address: string;
      amount: Array<{ unit: string; quantity: string }>;
    } | null;
    redeemerVersion: number;
    decodedNewContract: {
      blockchainIdentifier: string;
      payByTime: bigint;
      resultTime: bigint;
      unlockTime: bigint;
      externalDisputeUnlockTime: bigint;
      buyerVkey: string;
      buyerAddress: string;
      sellerVkey: string;
      sellerAddress: string;
      collateralReturnLovelace: bigint;
      resultHash: string;
      state: SmartContractState;
      buyerCooldownTime: bigint;
      sellerCooldownTime: bigint;
      inputHash: string;
    } | null;
    decodedOldContract: {
      blockchainIdentifier: string;
      payByTime: bigint;
      resultTime: bigint;
      unlockTime: bigint;
      externalDisputeUnlockTime: bigint;
      buyerVkey: string;
      buyerAddress: string;
      sellerVkey: string;
      sellerAddress: string;
      collateralReturnLovelace: bigint;
      resultHash: string;
      state: SmartContractState;
      buyerCooldownTime: bigint;
      sellerCooldownTime: bigint;
      inputHash: string;
    };
  },
  blockfrost: BlockFrostAPI,
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
  const paymentRequest = await prisma.paymentRequest.findUnique({
    where: {
      paymentSourceId: paymentContract.id,
      blockchainIdentifier:
        extractedData.decodedOldContract.blockchainIdentifier,
      payByTime: extractedData.decodedOldContract.payByTime,
      submitResultTime: extractedData.decodedOldContract.resultTime,
      unlockTime: extractedData.decodedOldContract.unlockTime,
      externalDisputeUnlockTime:
        extractedData.decodedOldContract.externalDisputeUnlockTime,
      BuyerWallet: {
        walletVkey: extractedData.decodedOldContract.buyerVkey,
        walletAddress: extractedData.decodedOldContract.buyerAddress,
      },
      SmartContractWallet: {
        walletVkey: extractedData.decodedOldContract.sellerVkey,
        walletAddress: extractedData.decodedOldContract.sellerAddress,
      },
    },
    include: {
      BuyerWallet: true,
      SmartContractWallet: { where: { deletedAt: null } },
      RequestedFunds: true,
      NextAction: true,
      CurrentTransaction: true,
      TransactionHistory: true,
    },
  });
  const purchasingRequest = await prisma.purchaseRequest.findUnique({
    where: {
      paymentSourceId: paymentContract.id,
      blockchainIdentifier:
        extractedData.decodedOldContract.blockchainIdentifier,
      payByTime: extractedData.decodedOldContract.payByTime,
      submitResultTime: extractedData.decodedOldContract.resultTime,
      unlockTime: extractedData.decodedOldContract.unlockTime,
      externalDisputeUnlockTime:
        extractedData.decodedOldContract.externalDisputeUnlockTime,
      SellerWallet: {
        walletVkey: extractedData.decodedOldContract.sellerVkey,
        walletAddress: extractedData.decodedOldContract.sellerAddress,
      },
      SmartContractWallet: {
        walletVkey: extractedData.decodedOldContract.buyerVkey,
        walletAddress: extractedData.decodedOldContract.buyerAddress,
      },
    },
    include: {
      SmartContractWallet: { where: { deletedAt: null } },
      SellerWallet: true,
      NextAction: true,
      CurrentTransaction: true,
      PaidFunds: true,
      TransactionHistory: true,
    },
  });

  if (paymentRequest == null && purchasingRequest == null) {
    //transaction is not registered with us or duplicated (therefore invalid)
    return;
  }

  const inputTxHashMatchPaymentRequest = await checkIfTxIsInHistory(
    paymentRequest?.CurrentTransaction?.txHash ?? 'no-tx',
    paymentRequest?.TransactionHistory ?? [],
    blockfrost,
    paymentContract.smartContractAddress,
    tx,
  );
  if (inputTxHashMatchPaymentRequest == false) {
    logger.warn(
      'Input tx hash does not match payment request tx hash. This likely is a spoofing attempt',
      {
        paymentRequest: paymentRequest,
        txHash: tx.tx.tx_hash,
      },
    );
  }
  const inputTxHashMatchPurchasingRequest = await checkIfTxIsInHistory(
    purchasingRequest?.CurrentTransaction?.txHash ?? 'no-tx',
    purchasingRequest?.TransactionHistory ?? [],
    blockfrost,
    paymentContract.smartContractAddress,
    tx,
  );
  if (inputTxHashMatchPurchasingRequest == false) {
    logger.warn(
      'Input tx hash does not match purchasing request tx hash. This likely is a spoofing attempt',
      {
        purchasingRequest: purchasingRequest,
        txHash: tx.tx.tx_hash,
      },
    );
  }

  let sellerWithdrawn: Array<{
    unit: string;
    quantity: bigint;
  }> = [];
  let buyerWithdrawn: Array<{
    unit: string;
    quantity: bigint;
  }> = [];

  const valueMatches = checkPaymentAmountsMatch(
    paymentRequest?.RequestedFunds ?? purchasingRequest?.PaidFunds ?? [],
    extractedData.valueOutput?.amount ?? [],
    extractedData.decodedOldContract.collateralReturnLovelace,
  );

  const newState: OnChainState | null = redeemerToOnChainState(
    extractedData.redeemerVersion,
    extractedData.decodedNewContract,
    valueMatches,
  );

  if (!newState) {
    logger.error(
      'Unexpected redeemer version detected. Possible invalid state in smart contract or bug in the software. tx_hash: ' +
        tx.tx.tx_hash,
    );
    return;
  }

  if (newState == OnChainState.DisputedWithdrawn) {
    sellerWithdrawn = calculateValueChange(
      tx.utxos.inputs,
      tx.utxos.outputs,
      extractedData.decodedOldContract.sellerVkey,
    );

    buyerWithdrawn = calculateValueChange(
      tx.utxos.inputs,
      tx.utxos.outputs,
      extractedData.decodedOldContract.buyerVkey,
    );
  }

  try {
    if (inputTxHashMatchPaymentRequest) {
      await handlePaymentTransactionCardanoV1(
        tx.tx.tx_hash,
        newState,
        paymentContract.id,
        extractedData.decodedOldContract.blockchainIdentifier,
        extractedData.decodedNewContract?.resultHash ??
          extractedData.decodedOldContract.resultHash,
        paymentRequest?.NextAction?.requestedAction ?? PurchasingAction.None,
        Number(extractedData.decodedNewContract?.buyerCooldownTime ?? 0),
        Number(extractedData.decodedNewContract?.sellerCooldownTime ?? 0),
        sellerWithdrawn,
        buyerWithdrawn,
      );
    }
  } catch (error) {
    logger.error('Error handling payment transaction', {
      error: error,
    });
  }
  try {
    if (inputTxHashMatchPurchasingRequest) {
      await handlePurchasingTransactionCardanoV1(
        tx.tx.tx_hash,
        newState,
        paymentContract.id,
        extractedData.decodedOldContract.blockchainIdentifier,
        extractedData.decodedNewContract?.resultHash ??
          extractedData.decodedOldContract.resultHash,
        purchasingRequest?.NextAction?.requestedAction ?? PurchasingAction.None,
        Number(extractedData.decodedNewContract?.buyerCooldownTime ?? 0),
        Number(extractedData.decodedNewContract?.sellerCooldownTime ?? 0),
        sellerWithdrawn,
        buyerWithdrawn,
      );
    }
  } catch (error) {
    logger.error('Error handling purchasing transaction', {
      error: error,
    });
  }
}
