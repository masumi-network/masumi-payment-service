import { CONFIG, CONSTANTS } from '@/utils/config';
import { prisma } from '@/utils/db';
import { logger } from '@/utils/logger';
import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { Transaction } from '@emurgo/cardano-serialization-lib-nodejs';
import { advancedRetryAll, delayErrorResolver } from 'advanced-retry';

async function detectRollbackForTxPage(
  txs: Array<{ tx_hash: string }>,
  paymentContractAddress: string,
  latestIdentifier: string,
  latestTx: Array<{ tx_hash: string }>,
) {
  let rolledBackTx: Array<{ tx_hash: string }> = [];
  //newest first
  for (let i = 0; i < txs.length; i++) {
    const exists = await prisma.paymentSourceIdentifiers.findUnique({
      where: {
        txHash: txs[i].tx_hash,
        PaymentSource: {
          smartContractAddress: paymentContractAddress,
        },
      },
    });
    if (exists != null) {
      const newerThanRollbackTxs =
        await prisma.paymentSourceIdentifiers.findMany({
          where: {
            createdAt: {
              gte: exists.createdAt,
            },
            PaymentSource: {
              smartContractAddress: paymentContractAddress,
            },
          },
          select: {
            txHash: true,
          },
        });
      rolledBackTx = [
        ...newerThanRollbackTxs.map((x) => {
          return {
            tx_hash: x.txHash,
          };
        }),
        { tx_hash: latestIdentifier },
      ].filter((x) => latestTx.findIndex((y) => y.tx_hash == x.tx_hash) == -1);
      rolledBackTx = rolledBackTx.reverse();

      const foundIndex = latestTx.findIndex((x) => x.tx_hash == txs[i].tx_hash);
      return { rolledBackTx, foundIndex };
    }
  }
  return null;
}

export async function getExtendedTxInformation(
  latestTxs: Array<{ tx_hash: string; block_time: number }>,
  blockfrost: BlockFrostAPI,
  maxTransactionToProcessInParallel: number,
) {
  const batchCount = Math.ceil(
    latestTxs.length / maxTransactionToProcessInParallel,
  );
  const txData: Array<{
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
  }> = [];
  for (let i = 0; i < batchCount; i++) {
    const txBatch = latestTxs.slice(
      i * maxTransactionToProcessInParallel,
      Math.min((i + 1) * maxTransactionToProcessInParallel, latestTxs.length),
    );

    const txDataBatch = await advancedRetryAll({
      operations: txBatch.map((tx) => async () => {
        const txDetails = await blockfrost.txs(tx.tx_hash);
        let block: { confirmations: number } = { confirmations: 0 };
        if (CONFIG.BLOCK_CONFIRMATIONS_THRESHOLD > 0) {
          block = await blockfrost.blocks(txDetails.block);
        }

        const cbor = await blockfrost.txsCbor(tx.tx_hash);
        const utxos = await blockfrost.txsUtxos(tx.tx_hash);

        const transaction = Transaction.from_bytes(
          Buffer.from(cbor.cbor, 'hex'),
        );
        return {
          tx: tx,
          block: block,
          utxos: utxos,
          transaction: transaction,
          blockTime: tx.block_time,
        };
      }),
      errorResolvers: [
        delayErrorResolver({
          configuration: {
            maxRetries: 5,
            backoffMultiplier: 2,
            initialDelayMs: 500,
            maxDelayMs: 15000,
          },
        }),
      ],
    });
    //filter out failed operations
    const filteredTxData = txDataBatch
      .filter((x) => x.success == true && x.result != undefined)
      .map((x) => x.result!);
    //log warning for failed operations
    const failedTxData = txDataBatch.filter((x) => x.success == false);
    if (failedTxData.length > 0) {
      logger.warn('Failed to get data for transactions: ignoring ', {
        tx: failedTxData,
      });
    }
    filteredTxData.forEach((x) => txData.push(x));
  }

  //sort by smallest block time first
  txData.sort((a, b) => {
    return a.blockTime - b.blockTime;
  });
  return txData;
}

export async function getTxsFromCardanoAfterSpecificTx(
  blockfrost: BlockFrostAPI,
  paymentContract: {
    smartContractAddress: string;
  },
  latestIdentifier: string | null,
) {
  let latestTx: Array<{ tx_hash: string; block_time: number }> = [];
  let foundTx = -1;
  let index = 0;
  let rolledBackTx: Array<{ tx_hash: string }> = [];
  do {
    index++;
    const txs = await blockfrost.addressesTransactions(
      paymentContract.smartContractAddress,
      { page: index, order: 'desc' },
    );
    if (txs.length == 0) {
      //we reached the last page of all smart contract transactions
      if (latestTx.length == 0) {
        logger.warn('No transactions found for payment contract', {
          paymentContractAddress: paymentContract.smartContractAddress,
        });
      }
      break;
    }

    latestTx.push(...txs);
    foundTx = txs.findIndex((tx) => tx.tx_hash == latestIdentifier);
    if (foundTx != -1) {
      const latestTxIndex = latestTx.findIndex(
        (tx) => tx.tx_hash == latestIdentifier,
      );
      latestTx = latestTx.slice(0, latestTxIndex);
    } else if (latestIdentifier != null) {
      // if not found we assume a rollback happened and need to check all previous txs
      const rollbackInfo = await detectRollbackForTxPage(
        txs,
        paymentContract.smartContractAddress,
        latestIdentifier,
        latestTx,
      );
      if (rollbackInfo != null) {
        rolledBackTx = rollbackInfo.rolledBackTx;
        foundTx = rollbackInfo.foundIndex;
        latestTx = latestTx.slice(0, rollbackInfo.foundIndex);
      }
    } else {
      logger.info(
        'Full sync in progress, processing tx page ' + index.toString(),
        {
          tx: txs[0],
        },
      );
    }
  } while (foundTx == -1);

  //invert to get oldest first
  latestTx = latestTx.reverse();
  return { latestTx, rolledBackTx };
}

//returns all tx hashes that are part of the smart contract interaction, excluding the initial purchase tx hash
export async function getSmartContractInteractionTxHistoryList(
  blockfrost: BlockFrostAPI,
  scriptAddress: string,
  txHash: string,
  lastTxHash: string,
  maxLevels: number = CONSTANTS.MAX_DEFAULT_SMART_CONTRACT_HISTORY_LEVELS,
) {
  let remainingLevels = maxLevels;
  let hashToCheck = txHash;
  const txHashes = [];
  while (remainingLevels > 0) {
    const tx = await blockfrost.txsUtxos(hashToCheck);
    const inputUtxos = tx.inputs.filter((x) =>
      x.address.startsWith(scriptAddress),
    );
    const outputUtxos = tx.outputs.filter((x) =>
      x.address.startsWith(scriptAddress),
    );
    if (inputUtxos.length != 1) {
      if (inputUtxos.find((x) => x.tx_hash == lastTxHash) != null) {
        txHashes.push(lastTxHash);
      }
      break;
    }
    txHashes.push(...inputUtxos.map((x) => x.tx_hash));
    if (txHashes.find((x) => x == lastTxHash) != null) {
      break;
    }
    if (outputUtxos.length > 1) {
      return [];
    }
    hashToCheck = inputUtxos[0].tx_hash;
    remainingLevels--;
  }
  return [...new Set(txHashes)];
}
