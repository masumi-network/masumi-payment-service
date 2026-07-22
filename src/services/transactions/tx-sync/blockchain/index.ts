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
			return { rolledBackTx, foundIndex, rollbackAnchor: txs[i].tx_hash };
		}
	}
	return null;
}

export async function getExtendedTxInformation(
	latestTxs: Array<{ tx_hash: string; block_time: number; block_height: number; tx_index: number }>,
	blockfrost: BlockFrostAPI,
	maxTransactionToProcessInParallel: number,
) {
	const batchCount = Math.ceil(latestTxs.length / maxTransactionToProcessInParallel);
	const txData: Array<{
		blockTime: number;
		blockHeight: number;
		txIndex: number;
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
	const failures: Array<{
		txHash: string;
		blockHeight: number | null;
		txIndex: number | null;
		error: unknown;
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
					// From the FETCHED details, never the caller's enumeration input.
					// The quarantine reconciler calls this with stub values (it only
					// has a txHash), and blockTime feeds the pay-by-time timeout check
					// in the tx handlers — a stubbed 0 there would make a timed-out
					// funds-lock look valid.
					blockTime: txDetails.block_time,
					blockHeight: txDetails.block_height,
					txIndex: txDetails.index,
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
		// Report failures rather than dropping them or throwing.
		//
		// Dropping (the original behaviour) advanced the checkpoint past the tx,
		// so a single failed lookup froze that request's state forever — silently,
		// at log level `error`, with no way to revisit it.
		//
		// Throwing (the later fix) refused to advance at all, which trades silent
		// data loss for head-of-line blocking: a tx that can never be fetched —
		// one rolled back mid-flight, say — stalls every later transaction for
		// that payment source indefinitely.
		//
		// Neither is acceptable, so the decision is handed to the caller, which
		// records failures durably (TxSyncQuarantine) before letting the
		// checkpoint move on.
		txDataBatch.forEach((result, index) => {
			const source = txBatch[index];
			if (result.success == true && result.result != undefined) {
				txData.push(result.result);
				return;
			}
			failures.push({
				txHash: source?.tx_hash ?? `batch-index-${index}`,
				blockHeight: source?.block_height ?? null,
				txIndex: source?.tx_index ?? null,
				error: result.success == false ? result.error : new Error('extended lookup returned no result'),
			});
		});
	}

	// Order by true chain position, oldest first. Sorting on blockTime alone
	// leaves txs sharing a block in arbitrary order, because every tx in a block
	// carries the same block_time — and the sync advances its checkpoint per tx,
	// so processing them out of chain order can move the cursor past a tx that
	// has not been handled yet.
	txData.sort((a, b) => {
		if (a.blockHeight !== b.blockHeight) return a.blockHeight - b.blockHeight;
		return a.txIndex - b.txIndex;
	});

	if (failures.length > 0) {
		logger.error('Extended tx lookup failed; quarantining so the checkpoint can advance without losing them', {
			txHashes: failures.map((x) => x.txHash),
		});
	}

	return { txData, failures };
}

export async function getTxsFromCardanoAfterSpecificTx(
	blockfrost: BlockFrostAPI,
	paymentContract: {
		smartContractAddress: string;
	},
	latestIdentifier: string | null,
) {
	// block_height/tx_index come back from `addressesTransactions` and are the
	// only way to order txs WITHIN a block — block_time is identical for all of
	// them. Dropping these fields here is what left same-block ordering
	// undefined downstream. See the sort in getExtendedTxInformation.
	let latestTx: Array<{ tx_hash: string; block_time: number; block_height: number; tx_index: number }> = [];
	let foundTx = -1;
	let index = 0;
	let rolledBackTx: Array<{ tx_hash: string }> = [];
	let rollbackAnchor: string | null = null;
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
				rollbackAnchor = rollbackInfo.rollbackAnchor;
				foundTx = rollbackInfo.foundIndex;
				latestTx = latestTx.slice(0, rollbackInfo.foundIndex);
			}
		} else if (index % 10 == 0) {
			logger.info('Full sync in progress, processing tx page ' + index.toString(), {
				tx: txs[0],
			});
		}
	} while (foundTx == -1);

	if (latestIdentifier != null && foundTx == -1) {
		// The cursor is absent from the complete canonical address history and
		// none of our stored predecessors survived either. Every stored cursor is
		// therefore on the orphaned branch. Rewind to null and return the complete
		// canonical history so the caller can perform a full resync. This also
		// covers an empty address history, including disappearance of the source's
		// first and only transaction.
		const orphanedIdentifiers = await prisma.paymentSourceIdentifiers.findMany({
			where: {
				PaymentSource: {
					smartContractAddress: paymentContract.smartContractAddress,
				},
			},
			select: { txHash: true },
			orderBy: { createdAt: 'asc' },
		});
		rolledBackTx = [...new Set([...orphanedIdentifiers.map((identifier) => identifier.txHash), latestIdentifier])].map(
			(txHash) => ({ tx_hash: txHash }),
		);
		rollbackAnchor = null;
	}

	//invert to get oldest first
	latestTx = latestTx.reverse();
	return { latestTx, rolledBackTx, rollbackAnchor };
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
