import { CONFIG, CONSTANTS } from '@masumi/payment-core/config';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { Transaction } from '@emurgo/cardano-serialization-lib-nodejs';
import { advancedRetryAll, delayErrorResolver } from 'advanced-retry';

export type TransactionMetadata = {
	fees: bigint;
	block_height: number;
	block_time: number;
	output_amount: Array<{ unit: string; quantity: string }>;
	utxo_count: number;
	withdrawal_count: number;
	asset_mint_or_burn_count: number;
	redeemer_count: number;
	valid_contract: boolean;
};

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
			const newerThanRollbackTxs = await prisma.paymentSourceIdentifiers.findMany({
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
	const batchCount = Math.ceil(latestTxs.length / maxTransactionToProcessInParallel);
	const txData: Array<{
		blockTime: number;
		tx: { tx_hash: string };
		block: { confirmations: number };
		metadata: TransactionMetadata;
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
		logger.info('Processing tx batch ' + i.toString() + ' of ' + batchCount.toString(), {});

		const txDataBatch = await advancedRetryAll({
			operations: txBatch.map((tx) => async () => {
				const txDetails = await blockfrost.txs(tx.tx_hash);
				let block: { confirmations: number } = { confirmations: 0 };
				if (CONFIG.BLOCK_CONFIRMATIONS_THRESHOLD > 0) {
					block = await blockfrost.blocks(txDetails.block);
				}

				const cbor = await blockfrost.txsCbor(tx.tx_hash);
				const utxos = await blockfrost.txsUtxos(tx.tx_hash);

				const transaction = Transaction.from_bytes(Buffer.from(cbor.cbor, 'hex'));

				const metadata: TransactionMetadata = {
					fees: BigInt(txDetails.fees),
					block_height: txDetails.block_height,
					block_time: txDetails.block_time,
					output_amount: txDetails.output_amount,
					utxo_count: txDetails.utxo_count,
					withdrawal_count: txDetails.withdrawal_count,
					asset_mint_or_burn_count: txDetails.asset_mint_or_burn_count,
					redeemer_count: txDetails.redeemer_count,
					valid_contract: txDetails.valid_contract,
				};

				return {
					tx: tx,
					block: block,
					metadata: metadata,
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
		const failedTxData = txDataBatch
			.map((result, index) => ({ result, txHash: txBatch[index]?.tx_hash ?? `batch-index-${index}` }))
			.filter(({ result }) => result.success == false);
		if (failedTxData.length > 0) {
			const failedTxHashes = failedTxData.map(({ txHash }) => txHash);
			logger.error('Failed to get extended data for transactions; halting tx-sync checkpoint advance', {
				txHashes: failedTxHashes,
				failures: failedTxData,
			});
			throw new Error(
				`Failed to get extended data for ${failedTxData.length} transaction(s): ${failedTxHashes.join(', ')}`,
			);
		}

		const filteredTxData = txDataBatch.filter((x) => x.success == true && x.result != undefined).map((x) => x.result!);
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
		const txs = await blockfrost.addressesTransactions(paymentContract.smartContractAddress, {
			page: index,
			order: 'desc',
		});
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
			const latestTxIndex = latestTx.findIndex((tx) => tx.tx_hash == latestIdentifier);
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
		} else if (index % 10 == 0) {
			logger.info('Full sync in progress, processing tx page ' + index.toString(), {
				tx: txs[0],
			});
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
	// Batch-aware ancestor walk. The previous implementation assumed a single
	// linear chain (exactly one script input per hop) and bailed the instant it
	// hit a tx with a different shape: it `break`ed on `inputUtxos.length != 1`
	// and `return []`ed on `outputUtxos.length > 1`. V2 batch transactions spend
	// N script UTxOs and produce N continuation outputs, so any chain whose
	// ancestor is a batch tx made this function return an incomplete/empty set,
	// which made `checkIfTxIsInHistory` a false negative — and the caller then
	// skipped the handler and advanced the per-source checkpoint past a
	// confirmed-but-unprocessed tx, permanently stranding the request.
	//
	// Instead, walk ALL script-input parents as a bounded breadth-first search:
	// each level expands the frontier by every script input of every tx in it,
	// recording the parent tx hashes, until we either reach `lastTxHash` or
	// exhaust the level budget. `maxLevels` bounds depth and the `visited` set
	// bounds total work and prevents re-expanding a tx reachable by multiple
	// paths (batch fan-in/out). The returned set is a superset of the old linear
	// walk, so it can only add true positives; the caller cross-checks each hash
	// against THIS request's own currentTx/TransactionHistory, so sibling
	// requests' hashes pulled in via a shared batch tx cannot cause a false
	// match.
	const txHashes = new Set<string>();
	const visited = new Set<string>();
	let frontier = [txHash];
	let remainingLevels = maxLevels;
	while (remainingLevels > 0 && frontier.length > 0) {
		const nextFrontier: string[] = [];
		for (const hashToCheck of frontier) {
			if (visited.has(hashToCheck)) {
				continue;
			}
			visited.add(hashToCheck);
			const tx = await blockfrost.txsUtxos(hashToCheck);
			const inputUtxos = tx.inputs.filter((x) => x.address.startsWith(scriptAddress));
			for (const input of inputUtxos) {
				txHashes.add(input.tx_hash);
				if (input.tx_hash != lastTxHash && !visited.has(input.tx_hash)) {
					nextFrontier.push(input.tx_hash);
				}
			}
		}
		// Stop as soon as the target predecessor is found anywhere in the
		// ancestor set — the common single-hop batch case resolves at level 1.
		if (txHashes.has(lastTxHash)) {
			break;
		}
		frontier = nextFrontier;
		remainingLevels--;
	}
	return [...txHashes];
}
