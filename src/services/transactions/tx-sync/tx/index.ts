import { prisma } from '@masumi/payment-core/db';
import { SmartContractState } from '@/utils/generator/contract-generator';
import { logger } from '@masumi/payment-core/logger';
import { Transaction } from '@emurgo/cardano-serialization-lib-nodejs';
import {
	Network,
	OnChainState,
	PaymentAction,
	PaymentErrorType,
	PaymentSource,
	PaymentSourceType,
	Prisma,
	PurchaseErrorType,
	PurchasingAction,
	TransactionStatus,
	WalletType,
} from '@/generated/prisma/client';
import {
	calculateValueChange,
	checkIfTxIsInHistory,
	checkPaymentAmountsMatch,
	ExtractedTransactionEntry,
	ExtractOnChainTransactionDataOutput,
	getCardanoFeesBuyer,
	getCardanoFeesSeller,
	redeemerToOnChainState,
} from '@/services/transactions/tx-sync/util';
import { deserializeDatum } from '@meshsdk/core';
import { DecodedV1ContractDatum } from '@/utils/converter/string-datum-convert';
import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { CONSTANTS } from '@masumi/payment-core/config';
import { TransactionMetadata } from '@/services/transactions/tx-sync/blockchain';
import { calculateMinUtxo, getLovelaceFromAmounts, getNativeTokenCount, DUMMY_RESULT_HASH } from '@/utils/min-utxo';
import { getBlockfrostInstance } from '@/utils/blockfrost';
import { getDatumNetwork, getPaymentSourceContractAdapter } from '@/services/payment-source-adapters';
import { retryOnSerializationConflict } from '@masumi/payment-core/db-retry';
import { withSerializableSlotRetry } from '@masumi/payment-core/serializable-semaphore';
import { TxSyncBeforeWrite } from '../quarantine/fenced-write';
import {
	handleV1PaymentTransaction,
	handleV1PurchasingTransaction,
} from '@masumi/payment-source-v1/services/tx-sync/handlers';
import {
	handleV2PaymentTransaction,
	handleV2PurchasingTransaction,
} from '@masumi/payment-source-v2/services/tx-sync/handlers';

export type UpdateTransactionInput = {
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
};

function nullableStringEquals(left: string | null | undefined, right: string | null | undefined) {
	return (left ?? null) === (right ?? null);
}

/**
 * Structural minimum needed to verify a PaymentRequest / PurchaseRequest row
 * against an on-chain datum after a lookup by `blockchainIdentifier` only.
 * Each `kind` ('payment' | 'purchase') swaps which relation holds the buyer
 * vs the seller wallet; see contract docs above the call sites.
 */
type RequestRowWithWallets = {
	payByTime: bigint | null;
	submitResultTime: bigint;
	unlockTime: bigint;
	externalDisputeUnlockTime: bigint;
	BuyerWallet?: { walletVkey: string; walletAddress: string } | null;
	SellerWallet?: { walletVkey: string; walletAddress: string } | null;
	SmartContractWallet?: { walletVkey: string; walletAddress: string } | null;
};

/**
 * Null-tolerant verification of DB fields against the on-chain datum. Returns
 * `true` when the row is consistent with the datum (or when the DB value is
 * null, which signals a legacy row pre-dating the column — accepted).
 *
 * Spoofing defence preserved: when a DB field is non-null AND diverges from
 * the on-chain value, log a warning and return `false` so the caller skips
 * the update. The legacy null case only applies to `payByTime` (added by
 * migration 20250622215253_add_pay_by_time without a backfill). All other
 * time fields are non-nullable in the schema and must match exactly.
 */
function verifyRequestFieldsAgainstDatum(
	request: RequestRowWithWallets,
	datum: DecodedV1ContractDatum,
	kind: 'payment' | 'purchase',
	txHash: string,
): boolean {
	if (request.payByTime != null && request.payByTime !== datum.payByTime) {
		logger.warn(`${kind} request payByTime does not match on-chain datum — likely spoofing attempt`, {
			txHash,
			dbPayByTime: request.payByTime,
			chainPayByTime: datum.payByTime,
		});
		return false;
	}
	if (request.submitResultTime !== datum.resultTime) {
		logger.warn(`${kind} request submitResultTime does not match on-chain datum — likely spoofing attempt`, {
			txHash,
			dbSubmitResultTime: request.submitResultTime,
			chainResultTime: datum.resultTime,
		});
		return false;
	}
	if (request.unlockTime !== datum.unlockTime) {
		logger.warn(`${kind} request unlockTime does not match on-chain datum — likely spoofing attempt`, {
			txHash,
			dbUnlockTime: request.unlockTime,
			chainUnlockTime: datum.unlockTime,
		});
		return false;
	}
	if (request.externalDisputeUnlockTime !== datum.externalDisputeUnlockTime) {
		logger.warn(`${kind} request externalDisputeUnlockTime does not match on-chain datum — likely spoofing attempt`, {
			txHash,
			dbExternalDisputeUnlockTime: request.externalDisputeUnlockTime,
			chainExternalDisputeUnlockTime: datum.externalDisputeUnlockTime,
		});
		return false;
	}
	// Payment-side: BuyerWallet holds buyer keys, SmartContractWallet holds the
	// seller's hot wallet keys. Purchase-side is symmetric — SellerWallet holds
	// the seller keys, SmartContractWallet holds the buyer's hot wallet keys.
	if (kind === 'payment') {
		if (
			request.BuyerWallet != null &&
			(request.BuyerWallet.walletVkey !== datum.buyerVkey || request.BuyerWallet.walletAddress !== datum.buyerAddress)
		) {
			logger.warn('payment request BuyerWallet does not match on-chain datum — likely spoofing attempt', {
				txHash,
				dbBuyerVkey: request.BuyerWallet.walletVkey,
				dbBuyerAddress: request.BuyerWallet.walletAddress,
				chainBuyerVkey: datum.buyerVkey,
				chainBuyerAddress: datum.buyerAddress,
			});
			return false;
		}
		if (
			request.SmartContractWallet != null &&
			(request.SmartContractWallet.walletVkey !== datum.sellerVkey ||
				request.SmartContractWallet.walletAddress !== datum.sellerAddress)
		) {
			logger.warn('payment request SmartContractWallet does not match on-chain datum — likely spoofing attempt', {
				txHash,
				dbSellerVkey: request.SmartContractWallet.walletVkey,
				dbSellerAddress: request.SmartContractWallet.walletAddress,
				chainSellerVkey: datum.sellerVkey,
				chainSellerAddress: datum.sellerAddress,
			});
			return false;
		}
	} else {
		if (
			request.SellerWallet != null &&
			(request.SellerWallet.walletVkey !== datum.sellerVkey ||
				request.SellerWallet.walletAddress !== datum.sellerAddress)
		) {
			logger.warn('purchase request SellerWallet does not match on-chain datum — likely spoofing attempt', {
				txHash,
				dbSellerVkey: request.SellerWallet.walletVkey,
				dbSellerAddress: request.SellerWallet.walletAddress,
				chainSellerVkey: datum.sellerVkey,
				chainSellerAddress: datum.sellerAddress,
			});
			return false;
		}
		if (
			request.SmartContractWallet != null &&
			(request.SmartContractWallet.walletVkey !== datum.buyerVkey ||
				request.SmartContractWallet.walletAddress !== datum.buyerAddress)
		) {
			logger.warn('purchase request SmartContractWallet does not match on-chain datum — likely spoofing attempt', {
				txHash,
				dbBuyerVkey: request.SmartContractWallet.walletVkey,
				dbBuyerAddress: request.SmartContractWallet.walletAddress,
				chainBuyerVkey: datum.buyerVkey,
				chainBuyerAddress: datum.buyerAddress,
			});
			return false;
		}
	}
	return true;
}

function v2ReturnAddressesMatch(left: DecodedV1ContractDatum, right: DecodedV1ContractDatum) {
	return (
		nullableStringEquals(left.buyerReturnAddress, right.buyerReturnAddress) &&
		nullableStringEquals(left.sellerReturnAddress, right.sellerReturnAddress)
	);
}

export async function updateRolledBackTransaction(
	rolledBackTx: Array<{ tx_hash: string }>,
	beforeWrite?: TxSyncBeforeWrite,
) {
	for (const tx of rolledBackTx) {
		const foundTransaction = await prisma.transaction.findMany({
			where: {
				txHash: tx.tx_hash,
			},
			select: { id: true },
		});
		for (const transaction of foundTransaction) {
			// Atomic rollback for one Transaction: mark it `RolledBack`, unlock
			// its BlocksWallet, and flag every PaymentRequest / PurchaseRequest
			// that references it as `WaitingForManualAction`. Running this as a
			// single Postgres transaction (with retry-on-serialization-conflict)
			// guarantees we never end up half-flagged — a partial failure had
			// the potential to leave the wallet unlocked while some requests
			// still pointed at the rolled-back Transaction, blocking operator
			// recovery on those rows. Retry handles the inevitable
			// contention with concurrent scheduler ticks that touch the same
			// HotWallet row.
			await retryOnSerializationConflict(
				() =>
					prisma.$transaction(
						async (innerTx) => {
							await beforeWrite?.(innerTx);
							const freshTransaction = await innerTx.transaction.findUniqueOrThrow({
								where: { id: transaction.id },
								include: {
									PaymentRequestCurrent: true,
									PaymentRequestHistory: true,
									PurchaseRequestCurrent: true,
									PurchaseRequestHistory: true,
									BlocksWallet: true,
								},
							});
							await innerTx.transaction.update({
								where: { id: transaction.id },
								data: {
									status: TransactionStatus.RolledBack,
									BlocksWallet: freshTransaction.BlocksWallet ? { disconnect: true } : undefined,
								},
							});
							if (freshTransaction.BlocksWallet != null) {
								await innerTx.hotWallet.update({
									where: { id: freshTransaction.BlocksWallet.id },
									data: {
										lockedAt: null,
									},
								});
							}

							// PaymentRequestCurrent / PurchaseRequestCurrent are arrays since the
							// V2 batch flow can reference one Transaction from N requests
							// (currentTransactionId no longer @unique). For each affected request
							// we move the current NextAction to history and write a new
							// WaitingForManualAction so the operator can inspect the rollback.
							// Automatic resync is intentionally NOT done here — rollbacks may
							// signal datum drift or external double-spends, neither of which
							// is safe to retry without operator review.
							const paymentRequestsToFlag = [
								...freshTransaction.PaymentRequestCurrent.map((pr) => ({
									id: pr.id,
									nextActionId: pr.nextActionId,
								})),
								...freshTransaction.PaymentRequestHistory.map((pr) => ({
									id: pr.id,
									nextActionId: pr.nextActionId,
								})),
							];
							for (const pr of new Map(paymentRequestsToFlag.map((request) => [request.id, request])).values()) {
								await innerTx.paymentRequest.update({
									where: { id: pr.id },
									data: {
										ActionHistory: { connect: { id: pr.nextActionId } },
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
							const purchaseRequestsToFlag = [
								...freshTransaction.PurchaseRequestCurrent.map((pr) => ({
									id: pr.id,
									nextActionId: pr.nextActionId,
								})),
								...freshTransaction.PurchaseRequestHistory.map((pr) => ({
									id: pr.id,
									nextActionId: pr.nextActionId,
								})),
							];
							for (const pr of new Map(purchaseRequestsToFlag.map((request) => [request.id, request])).values()) {
								await innerTx.purchaseRequest.update({
									where: { id: pr.id },
									data: {
										ActionHistory: { connect: { id: pr.nextActionId } },
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
												},
											},
										},
									},
								});
							}
						},
						{ isolationLevel: 'Serializable', timeout: 30_000, maxWait: 30_000 },
					),
				{ label: 'tx-sync-rollback' },
			);
		}
	}
}
export async function updateInitialTransactions(
	valueOutputs: Extract<ExtractOnChainTransactionDataOutput, { type: 'Initial' }>['valueOutputs'],
	paymentContract: {
		id: string;
		network: Network;
		paymentSourceType: PaymentSourceType;
		smartContractAddress: string;
	},
	tx: UpdateTransactionInput,
	rpcProviderApiKey: string,
	beforeWrite?: TxSyncBeforeWrite,
) {
	// Pre-filter to valid initial outputs (datum present AND decodes against the
	// payment-source adapter). V2 batch txs emit one continuation output per
	// locked request, so a single tx can carry N valid outputs. Charging the
	// full `tx.metadata.fees` to EACH output's buyer would N-times-over-credit
	// the fee column. Pro-rate the total fee by the number of valid outputs;
	// the first valid output absorbs any rounding remainder so the sum across
	// outputs equals the full tx fee exactly. V1 (and non-batch V2) always has
	// exactly one valid Initial output, so the share equals the full fee and
	// behavior is unchanged.
	const adapter = getPaymentSourceContractAdapter(paymentContract.paymentSourceType);
	const datumNetwork = getDatumNetwork(paymentContract.network);
	type ValidOutput = {
		output: (typeof valueOutputs)[number];
		decodedNewContract: NonNullable<ReturnType<typeof adapter.decodeContractDatum>>;
	};
	const validOutputs: ValidOutput[] = [];
	for (const output of valueOutputs) {
		const outputDatum = output.inline_datum;
		if (outputDatum == null) continue;
		const decodedOutputDatum: unknown = deserializeDatum(outputDatum);
		const decodedNewContract = adapter.decodeContractDatum(
			decodedOutputDatum,
			datumNetwork,
			paymentContract.smartContractAddress,
		);
		if (decodedNewContract == null) continue;
		validOutputs.push({ output, decodedNewContract });
	}

	if (validOutputs.length === 0) return;

	const totalFees = tx.metadata.fees;
	const validCount = BigInt(validOutputs.length);
	const baseShare = totalFees / validCount;
	const remainder = totalFees - baseShare * validCount;

	for (let i = 0; i < validOutputs.length; i++) {
		const { output, decodedNewContract } = validOutputs[i];
		const buyerCardanoFees = baseShare + (i === 0 ? remainder : 0n);
		const sellerCardanoFees = BigInt(0);

		await updateInitialPurchaseTransaction(
			paymentContract,
			decodedNewContract,
			output,
			tx,
			tx.metadata,
			buyerCardanoFees,
			sellerCardanoFees,
			beforeWrite,
		);

		await updateInitialPaymentTransaction(
			decodedNewContract,
			paymentContract,
			tx,
			output,
			tx.metadata,
			buyerCardanoFees,
			sellerCardanoFees,
			rpcProviderApiKey,
			beforeWrite,
		);
	}
}
async function updateInitialPurchaseTransaction(
	paymentContract: { id: string; network: Network; paymentSourceType: PaymentSourceType; smartContractAddress: string },
	decodedNewContract: DecodedV1ContractDatum,
	output: Extract<ExtractOnChainTransactionDataOutput, { type: 'Initial' }>['valueOutputs'][number],
	tx: UpdateTransactionInput,
	metadata: TransactionMetadata,
	buyerCardanoFees: bigint,
	sellerCardanoFees: bigint,
	beforeWrite?: TxSyncBeforeWrite,
) {
	// Gate Serializable $transaction through the shared semaphore so the pg
	// connection pool isn't exhausted when scheduler ticks fan out across
	// payment sources. See `src/utils/db/serializable-semaphore.ts`.
	await withSerializableSlotRetry(
		() =>
			prisma.$transaction(
				async (prisma) => {
					await beforeWrite?.(prisma);
					const dbEntry = await prisma.purchaseRequest.findUnique({
						where: {
							blockchainIdentifier: decodedNewContract.blockchainIdentifier,
						},
						include: {
							SmartContractWallet: { where: { deletedAt: null } },
							SellerWallet: true,
							NextAction: true,
							CurrentTransaction: {
								include: { BlocksWallet: true },
							},
						},
					});
					if (dbEntry == null) {
						logger.warn('tx-sync: initial purchase output has no matching local purchase row', {
							txHash: tx.tx.tx_hash,
							paymentSourceId: paymentContract.id,
							blockchainIdentifier: decodedNewContract.blockchainIdentifier,
						});
						return;
					}
					if (dbEntry.paymentSourceId !== paymentContract.id) {
						logger.warn('tx-sync: initial purchase output matched a purchase from a different payment source', {
							txHash: tx.tx.tx_hash,
							paymentSourceId: paymentContract.id,
							purchaseRequestId: dbEntry.id,
							purchasePaymentSourceId: dbEntry.paymentSourceId,
							blockchainIdentifier: decodedNewContract.blockchainIdentifier,
						});
						return;
					}
					const isInitialFundsLockAction =
						dbEntry.NextAction.requestedAction === PurchasingAction.FundsLockingInitiated ||
						dbEntry.NextAction.requestedAction === PurchasingAction.FundsLockingRequested;
					if (!isInitialFundsLockAction) {
						logger.info('tx-sync: initial purchase output already handled or not awaiting funds lock', {
							txHash: tx.tx.tx_hash,
							purchaseRequestId: dbEntry.id,
							requestedAction: dbEntry.NextAction.requestedAction,
							onChainState: dbEntry.onChainState,
							blockchainIdentifier: decodedNewContract.blockchainIdentifier,
						});
						return;
					}
					if (dbEntry.SmartContractWallet == null) {
						logger.error('No smart contract wallet set for purchase request in db', {
							purchaseRequest: dbEntry,
						});
						await prisma.purchaseRequest.update({
							where: { id: dbEntry.id },
							data: {
								ActionHistory: {
									connect: {
										id: dbEntry.nextActionId,
									},
								},
								NextAction: {
									create: {
										requestedAction: PurchasingAction.WaitingForManualAction,
										errorNote:
											'No smart contract wallet set for purchase request in db. This is likely an internal error.',
										errorType: PurchaseErrorType.Unknown,
									},
								},
							},
						});
						return;
					}

					if (dbEntry.SellerWallet == null) {
						logger.error('No seller wallet set for purchase request in db. This seems like an internal error.', {
							purchaseRequest: dbEntry,
						});
						await prisma.purchaseRequest.update({
							where: { id: dbEntry.id },
							data: {
								ActionHistory: {
									connect: {
										id: dbEntry.nextActionId,
									},
								},
								NextAction: {
									create: {
										requestedAction: PurchasingAction.WaitingForManualAction,
										errorNote: 'No seller wallet set for purchase request in db. This seems like an internal error.',
										errorType: PurchaseErrorType.Unknown,
									},
								},
							},
						});
						return;
					}

					// Symmetric with `updateInitialPaymentTransaction` payment-side
					// (line ~861): every spoofing-style validation failure flips
					// `newAction` to WaitingForManualAction + `newState` to
					// FundsOrDatumInvalid and accumulates a human-readable error
					// note. Previously these branches `return`ed silently, leaving
					// purchase rows stuck in FundsLockingInitiated indefinitely
					// after a spoofing attempt (operator could never see them in
					// any actionable queue).
					let newAction: PurchasingAction = PurchasingAction.WaitingForExternalAction;
					let newState: OnChainState = OnChainState.FundsLocked;
					const errorNote: string[] = [];

					if (output.reference_script_hash != null) {
						const errorMessage =
							'Reference script hash is not null, this should not be set. This likely is a spoofing attempt.';
						logger.warn(errorMessage, { tx: tx.tx.tx_hash, purchaseRequest: dbEntry });
						newAction = PurchasingAction.WaitingForManualAction;
						newState = OnChainState.FundsOrDatumInvalid;
						errorNote.push(errorMessage);
					}
					if (dbEntry.inputHash !== decodedNewContract.inputHash) {
						const errorMessage =
							'Purchase request input hash does not match input hash in contract. This is likely a spoofing attempt.';
						logger.error(errorMessage, {
							purchaseRequest: dbEntry,
							inputHash: dbEntry.inputHash,
							inputHashContract: decodedNewContract.inputHash,
						});
						newAction = PurchasingAction.WaitingForManualAction;
						newState = OnChainState.FundsOrDatumInvalid;
						errorNote.push(errorMessage);
					}

					if (
						decodedNewContract.sellerVkey != dbEntry.SellerWallet.walletVkey ||
						decodedNewContract.sellerAddress != dbEntry.SellerWallet.walletAddress
					) {
						const errorMessage = 'Seller does not match seller in db. This likely is a spoofing attempt.';
						logger.warn(errorMessage, {
							purchaseRequest: dbEntry,
							sender: decodedNewContract.sellerVkey,
							senderAddress: decodedNewContract.sellerAddress,
							senderDb: dbEntry.SmartContractWallet?.walletVkey,
							senderDbAddress: dbEntry.SmartContractWallet?.walletAddress,
						});
						newAction = PurchasingAction.WaitingForManualAction;
						newState = OnChainState.FundsOrDatumInvalid;
						errorNote.push(errorMessage);
					}
					if (tx.utxos.inputs.find((x) => x.address == decodedNewContract.buyerAddress) == null) {
						const errorMessage = 'Buyer address not found in inputs, this likely is a spoofing attempt.';
						logger.warn(errorMessage, {
							purchaseRequest: dbEntry,
							buyerAddress: decodedNewContract.buyerAddress,
						});
						newAction = PurchasingAction.WaitingForManualAction;
						newState = OnChainState.FundsOrDatumInvalid;
						errorNote.push(errorMessage);
					}

					if (BigInt(decodedNewContract.collateralReturnLovelace) != dbEntry.collateralReturnLovelace) {
						const errorMessage =
							'Collateral return lovelace does not match collateral return lovelace in db. This likely is a spoofing attempt.';
						logger.warn(errorMessage, {
							purchaseRequest: dbEntry,
							collateralReturnLovelace: decodedNewContract.collateralReturnLovelace,
							collateralReturnLovelaceDb: dbEntry.collateralReturnLovelace,
						});
						newAction = PurchasingAction.WaitingForManualAction;
						newState = OnChainState.FundsOrDatumInvalid;
						errorNote.push(errorMessage);
					}

					if (BigInt(decodedNewContract.payByTime) != dbEntry.payByTime) {
						const errorMessage = 'Pay by time does not match pay by time in db. This likely is a spoofing attempt.';
						logger.warn(errorMessage, { purchaseRequest: dbEntry });
						newAction = PurchasingAction.WaitingForManualAction;
						newState = OnChainState.FundsOrDatumInvalid;
						errorNote.push(errorMessage);
					}

					const blockTime = tx.blockTime;
					if (blockTime * 1000 > decodedNewContract.payByTime) {
						const errorMessage = 'Block time is after pay by time. This is a timed out purchase.';
						logger.warn(errorMessage, {
							purchaseRequest: dbEntry,
							blockTime: blockTime * 1000,
							payByTime: decodedNewContract.payByTime,
						});
						newAction = PurchasingAction.WaitingForManualAction;
						newState = OnChainState.FundsOrDatumInvalid;
						errorNote.push(errorMessage);
					}

					const expectedBuyerVkey = dbEntry.SmartContractWallet?.walletVkey;
					const expectedBuyerAddress = dbEntry.SmartContractWallet?.walletAddress;
					const isBuyerVkeyMismatch = expectedBuyerVkey != null && decodedNewContract.buyerVkey !== expectedBuyerVkey;
					const isBuyerAddressMismatch =
						expectedBuyerAddress != null && decodedNewContract.buyerAddress !== expectedBuyerAddress;
					if (isBuyerVkeyMismatch || isBuyerAddressMismatch) {
						const errorMessage = 'Buyer does not match buyer in db. This likely is a spoofing attempt.';
						logger.warn(errorMessage, {
							purchaseRequest: dbEntry,
							buyer: decodedNewContract.buyerVkey,
							buyerAddress: decodedNewContract.buyerAddress,
							buyerDb: expectedBuyerVkey,
							buyerDbAddress: expectedBuyerAddress,
						});
						newAction = PurchasingAction.WaitingForManualAction;
						newState = OnChainState.FundsOrDatumInvalid;
						errorNote.push(errorMessage);
					}
					if (decodedNewContract.state != SmartContractState.FundsLocked) {
						const errorMessage = 'State is not funds locked. This likely is a spoofing attempt.';
						logger.warn(errorMessage, {
							purchaseRequest: dbEntry,
							state: decodedNewContract.state,
						});
						newAction = PurchasingAction.WaitingForManualAction;
						newState = OnChainState.FundsOrDatumInvalid;
						errorNote.push(errorMessage);
					}
					if (decodedNewContract.resultHash != null) {
						const errorMessage = 'Result hash was set. This likely is a spoofing attempt.';
						logger.warn(errorMessage, {
							purchaseRequest: dbEntry,
							resultHash: decodedNewContract.resultHash,
						});
						newAction = PurchasingAction.WaitingForManualAction;
						newState = OnChainState.FundsOrDatumInvalid;
						errorNote.push(errorMessage);
					}
					if (BigInt(decodedNewContract.resultTime) != dbEntry.submitResultTime) {
						const errorMessage = 'Result time is not the agreed upon time. This likely is a spoofing attempt.';
						logger.warn(errorMessage, {
							purchaseRequest: dbEntry,
							resultTime: decodedNewContract.resultTime,
							resultTimeDb: dbEntry.submitResultTime,
						});
						newAction = PurchasingAction.WaitingForManualAction;
						newState = OnChainState.FundsOrDatumInvalid;
						errorNote.push(errorMessage);
					}
					if (decodedNewContract.unlockTime < dbEntry.unlockTime) {
						const errorMessage = 'Unlock time is before the agreed upon time. This likely is a spoofing attempt.';
						logger.warn(errorMessage, {
							purchaseRequest: dbEntry,
							unlockTime: decodedNewContract.unlockTime,
							unlockTimeDb: dbEntry.unlockTime,
						});
						newAction = PurchasingAction.WaitingForManualAction;
						newState = OnChainState.FundsOrDatumInvalid;
						errorNote.push(errorMessage);
					}
					if (BigInt(decodedNewContract.externalDisputeUnlockTime) != dbEntry.externalDisputeUnlockTime) {
						const errorMessage =
							'External dispute unlock time is not the agreed upon time. This likely is a spoofing attempt.';
						logger.warn(errorMessage, {
							purchaseRequest: dbEntry,
							externalDisputeUnlockTime: decodedNewContract.externalDisputeUnlockTime,
							externalDisputeUnlockTimeDb: dbEntry.externalDisputeUnlockTime,
						});
						newAction = PurchasingAction.WaitingForManualAction;
						newState = OnChainState.FundsOrDatumInvalid;
						errorNote.push(errorMessage);
					}
					if (BigInt(decodedNewContract.buyerCooldownTime) != BigInt(0)) {
						const errorMessage = 'Buyer cooldown time is not 0. This likely is a spoofing attempt.';
						logger.warn(errorMessage, {
							purchaseRequest: dbEntry,
							buyerCooldownTime: decodedNewContract.buyerCooldownTime,
						});
						newAction = PurchasingAction.WaitingForManualAction;
						newState = OnChainState.FundsOrDatumInvalid;
						errorNote.push(errorMessage);
					}
					if (BigInt(decodedNewContract.sellerCooldownTime) != BigInt(0)) {
						const errorMessage = 'Seller cooldown time is not 0. This likely is a spoofing attempt.';
						logger.warn(errorMessage, {
							purchaseRequest: dbEntry,
							sellerCooldownTime: decodedNewContract.sellerCooldownTime,
						});
						newAction = PurchasingAction.WaitingForManualAction;
						newState = OnChainState.FundsOrDatumInvalid;
						errorNote.push(errorMessage);
					}
					if (
						paymentContract.paymentSourceType === PaymentSourceType.Web3CardanoV2 &&
						(!nullableStringEquals(decodedNewContract.buyerReturnAddress, dbEntry.buyerReturnAddress) ||
							!nullableStringEquals(decodedNewContract.sellerReturnAddress, dbEntry.sellerReturnAddress))
					) {
						const errorMessage =
							'Return addresses do not match return addresses in db. This likely is a spoofing attempt.';
						logger.warn(errorMessage, {
							purchaseRequest: dbEntry,
							buyerReturnAddress: decodedNewContract.buyerReturnAddress,
							buyerReturnAddressDb: dbEntry.buyerReturnAddress,
							sellerReturnAddress: decodedNewContract.sellerReturnAddress,
							sellerReturnAddressDb: dbEntry.sellerReturnAddress,
						});
						newAction = PurchasingAction.WaitingForManualAction;
						newState = OnChainState.FundsOrDatumInvalid;
						errorNote.push(errorMessage);
					}
					//TODO: optional check amounts
					await prisma.purchaseRequest.update({
						where: { id: dbEntry.id },
						data: {
							totalBuyerCardanoFees: { increment: buyerCardanoFees },
							totalSellerCardanoFees: { increment: sellerCardanoFees },
							ActionHistory: {
								connect: {
									id: dbEntry.nextActionId,
								},
							},
							NextAction: {
								create: {
									requestedAction: newAction,
									errorNote: errorNote.length > 0 ? errorNote.join(';\n ') : undefined,
									errorType: errorNote.length > 0 ? PurchaseErrorType.Unknown : undefined,
								},
							},
							CurrentTransaction: dbEntry.currentTransactionId
								? {
										update: {
											txHash: tx.tx.tx_hash,
											status: TransactionStatus.Confirmed,
											confirmations: tx.block.confirmations,
											previousOnChainState: null,
											newOnChainState: newState,
											fees: metadata.fees,
											blockHeight: metadata.block_height,
											blockTime: metadata.block_time,
											outputAmount: JSON.stringify(metadata.output_amount),
											utxoCount: metadata.utxo_count,
											withdrawalCount: metadata.withdrawal_count,
											assetMintOrBurnCount: metadata.asset_mint_or_burn_count,
											redeemerCount: metadata.redeemer_count,
											validContract: metadata.valid_contract,
										},
									}
								: {
										create: {
											txHash: tx.tx.tx_hash,
											status: TransactionStatus.Confirmed,
											confirmations: tx.block.confirmations,
											previousOnChainState: null,
											newOnChainState: newState,
											fees: metadata.fees,
											blockHeight: metadata.block_height,
											blockTime: metadata.block_time,
											outputAmount: JSON.stringify(metadata.output_amount),
											utxoCount: metadata.utxo_count,
											withdrawalCount: metadata.withdrawal_count,
											assetMintOrBurnCount: metadata.asset_mint_or_burn_count,
											redeemerCount: metadata.redeemer_count,
											validContract: metadata.valid_contract,
										},
									},
							onChainState: newState,
							resultHash: decodedNewContract.resultHash,
						},
					});
					if (
						dbEntry.currentTransactionId != null &&
						dbEntry.CurrentTransaction?.BlocksWallet != null &&
						dbEntry.SmartContractWallet != null
					) {
						const lockedWalletId = dbEntry.CurrentTransaction.BlocksWallet.id;
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
								id: lockedWalletId,
								deletedAt: null,
							},
							data: {
								lockedAt: null,
							},
						});
						logger.info('tx-sync: unlocked purchasing wallet after initial funds-lock confirmation', {
							purchaseRequestId: dbEntry.id,
							transactionId: dbEntry.currentTransactionId,
							txHash: tx.tx.tx_hash,
							walletId: lockedWalletId,
						});
					}
				},
				{
					isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
					timeout: 30_000,
					maxWait: 30_000,
				},
			),
		{ label: 'tx-sync-handle-2' },
	);
}

async function updateInitialPaymentTransaction(
	decodedNewContract: DecodedV1ContractDatum,
	paymentContract: { id: string; network: Network; paymentSourceType: PaymentSourceType; smartContractAddress: string },
	tx: UpdateTransactionInput,
	output: Extract<ExtractOnChainTransactionDataOutput, { type: 'Initial' }>['valueOutputs'][number],
	metadata: TransactionMetadata,
	buyerCardanoFees: bigint,
	sellerCardanoFees: bigint,
	rpcProviderApiKey: string,
	beforeWrite?: TxSyncBeforeWrite,
) {
	// Gate Serializable $transaction through the shared semaphore so the pg
	// connection pool isn't exhausted when scheduler ticks fan out across
	// payment sources. See `src/utils/db/serializable-semaphore.ts`.
	await withSerializableSlotRetry(
		() =>
			prisma.$transaction(
				async (prisma) => {
					await beforeWrite?.(prisma);
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
						logger.error('Existing buyer set for payment request in db. This is likely an internal error.', {
							paymentRequest: dbEntry,
						});
						await prisma.paymentRequest.update({
							where: { id: dbEntry.id },
							data: {
								ActionHistory: {
									connect: {
										id: dbEntry.nextActionId,
									},
								},
								NextAction: {
									create: {
										requestedAction: PaymentAction.WaitingForManualAction,
										errorNote: 'Existing buyer set for payment request in db. This is likely an internal error.',
										errorType: PaymentErrorType.Unknown,
									},
								},
							},
						});
						return;
					}
					if (dbEntry.SmartContractWallet == null) {
						logger.error('No smart contract wallet set for payment request in db. This is likely an internal error.', {
							paymentRequest: dbEntry,
						});
						await prisma.paymentRequest.update({
							where: { id: dbEntry.id },
							data: {
								ActionHistory: {
									connect: {
										id: dbEntry.nextActionId,
									},
								},
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
					if (tx.utxos.inputs.find((x) => x.address == decodedNewContract.buyerAddress) == null) {
						// Do not mark the request invalid here: a third party can
						// create a spoofed output with our blockchainIdentifier.
						// Leave the request unchanged so the legitimate buyer lock
						// can still be synced when it appears.
						logger.warn('Ignoring initial payment tx because buyer address is not an input; likely spoof noise.', {
							txHash: tx.tx.tx_hash,
							paymentRequestId: dbEntry.id,
							blockchainIdentifier: decodedNewContract.blockchainIdentifier,
							buyerAddress: decodedNewContract.buyerAddress,
						});
						return;
					}
					if (BigInt(decodedNewContract.payByTime) != dbEntry.payByTime) {
						const errorMessage = 'Pay by time does not match pay by time in db. This likely is a spoofing attempt.';
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
						const errorMessage = 'Block time is after pay by time. This is a timed out purchase.';
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
						const errorMessage = 'Reference script hash is not null. This likely is a spoofing attempt.';
						logger.warn(errorMessage, { tx: tx.tx.tx_hash });
						newAction = PaymentAction.WaitingForManualAction;
						newState = OnChainState.FundsOrDatumInvalid;
						errorNote.push(errorMessage);
					}
					if (
						decodedNewContract.sellerVkey != dbEntry.SmartContractWallet.walletVkey ||
						decodedNewContract.sellerAddress != dbEntry.SmartContractWallet.walletAddress
					) {
						const errorMessage = 'Seller does not match seller in db. This likely is a spoofing attempt.';
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
					if (decodedNewContract.state != SmartContractState.FundsLocked) {
						const errorMessage = 'State is not funds locked. This likely is a spoofing attempt.';
						logger.warn(errorMessage, {
							paymentRequest: dbEntry,
							state: decodedNewContract.state,
						});
						newAction = PaymentAction.WaitingForManualAction;
						newState = OnChainState.FundsOrDatumInvalid;
						errorNote.push(errorMessage);
					}
					if (decodedNewContract.resultHash != null) {
						const errorMessage = 'Result hash was set. This likely is a spoofing attempt.';
						logger.warn(errorMessage, {
							paymentRequest: dbEntry,
							resultHash: decodedNewContract.resultHash,
						});
						newAction = PaymentAction.WaitingForManualAction;
						newState = OnChainState.FundsOrDatumInvalid;
						errorNote.push(errorMessage);
					}
					if (BigInt(decodedNewContract.resultTime) != dbEntry.submitResultTime) {
						const errorMessage = 'Result time is not the agreed upon time. This likely is a spoofing attempt.';
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
						const errorMessage = 'Unlock time is before the agreed upon time. This likely is a spoofing attempt.';
						logger.warn(errorMessage, {
							paymentRequest: dbEntry,
							unlockTime: decodedNewContract.unlockTime,
							unlockTimeDb: dbEntry.unlockTime,
						});
						newAction = PaymentAction.WaitingForManualAction;
						newState = OnChainState.FundsOrDatumInvalid;
						errorNote.push(errorMessage);
					}
					if (BigInt(decodedNewContract.externalDisputeUnlockTime) != dbEntry.externalDisputeUnlockTime) {
						const errorMessage =
							'External dispute unlock time is not the agreed upon time. This likely is a spoofing attempt.';
						logger.warn(errorMessage, {
							paymentRequest: dbEntry,
							externalDisputeUnlockTime: decodedNewContract.externalDisputeUnlockTime,
							externalDisputeUnlockTimeDb: dbEntry.externalDisputeUnlockTime,
						});
						newAction = PaymentAction.WaitingForManualAction;
						newState = OnChainState.FundsOrDatumInvalid;
						errorNote.push(errorMessage);
					}
					if (BigInt(decodedNewContract.buyerCooldownTime) != BigInt(0)) {
						const errorMessage = 'Buyer cooldown time is not 0. This likely is a spoofing attempt.';
						logger.warn(errorMessage, {
							paymentRequest: dbEntry,
							buyerCooldownTime: decodedNewContract.buyerCooldownTime,
						});
						newAction = PaymentAction.WaitingForManualAction;
						newState = OnChainState.FundsOrDatumInvalid;
						errorNote.push(errorMessage);
					}
					if (BigInt(decodedNewContract.sellerCooldownTime) != BigInt(0)) {
						const errorMessage = 'Seller cooldown time is not 0. This likely is a spoofing attempt.';
						logger.warn(errorMessage, {
							paymentRequest: dbEntry,
							sellerCooldownTime: decodedNewContract.sellerCooldownTime,
						});
						newAction = PaymentAction.WaitingForManualAction;
						newState = OnChainState.FundsOrDatumInvalid;
						errorNote.push(errorMessage);
					}
					if (
						paymentContract.paymentSourceType === PaymentSourceType.Web3CardanoV2 &&
						!nullableStringEquals(decodedNewContract.sellerReturnAddress, dbEntry.sellerReturnAddress)
					) {
						const errorMessage = 'Seller return address does not match seller return address in db.';
						logger.warn(errorMessage, {
							paymentRequest: dbEntry,
							sellerReturnAddress: decodedNewContract.sellerReturnAddress,
							sellerReturnAddressDb: dbEntry.sellerReturnAddress,
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
						const errorMessage = 'Payment amounts do not match. This likely is a spoofing attempt.';
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
						const errorMessage = 'Token counts do not match. This likely is a spoofing attempt.';
						logger.warn(errorMessage, {
							paymentRequest: dbEntry,
							amounts: output.amount,
							amountsDb: dbEntry.RequestedFunds,
						});
						newAction = PaymentAction.WaitingForManualAction;
						newState = OnChainState.FundsOrDatumInvalid;
						errorNote.push(errorMessage);
					}

					try {
						let coinsPerUtxoSize: number = CONSTANTS.FALLBACK_COINS_PER_UTXO_SIZE;
						try {
							const blockfrost = getBlockfrostInstance(paymentContract.network, rpcProviderApiKey);
							const protocolParams = await blockfrost.epochsLatestParameters();
							if (protocolParams.coins_per_utxo_size != null) {
								coinsPerUtxoSize = Number(protocolParams.coins_per_utxo_size);
							}
							logger.debug('Fetched protocol parameters for min-UTXO validation', {
								coinsPerUtxoSize,
								paymentRequestId: dbEntry.id,
							});
						} catch (protocolFetchError) {
							logger.warn('Failed to fetch protocol parameters for validation, using fallback', {
								fallbackCoinsPerUtxoSize: coinsPerUtxoSize,
								paymentRequestId: dbEntry.id,
								error: protocolFetchError instanceof Error ? protocolFetchError.message : String(protocolFetchError),
							});
						}

						const adapter = getPaymentSourceContractAdapter(paymentContract.paymentSourceType);
						const datumWithResultHash = adapter.createDatumFromDecodedContract({
							decodedContract: decodedNewContract,
							buyerAddress: decodedNewContract.buyerAddress,
							sellerAddress: decodedNewContract.sellerAddress,
							blockchainIdentifier: decodedNewContract.blockchainIdentifier,
							resultHash: DUMMY_RESULT_HASH,
							newCooldownTimeSeller: BigInt(0),
							newCooldownTimeBuyer: BigInt(0),
							state: SmartContractState.ResultSubmitted,
						});

						const nativeTokenCount = getNativeTokenCount(output.amount);
						const minUtxoResult = calculateMinUtxo({
							datum: datumWithResultHash.value,
							nativeTokenCount,
							coinsPerUtxoSize,
							includeBuffers: true,
						});

						const actualLovelace = getLovelaceFromAmounts(output.amount);

						if (actualLovelace < minUtxoResult.minUtxoLovelace) {
							const shortfall = minUtxoResult.minUtxoLovelace - actualLovelace;
							logger.warn('Payment may be underfunded for result submission. Top-up will be applied.', {
								paymentRequestId: dbEntry.id,
								actualLovelace: actualLovelace.toString(),
								requiredMinUtxo: minUtxoResult.minUtxoLovelace.toString(),
								shortfall: shortfall.toString(),
								nativeTokenCount,
								coinsPerUtxoSize,
								collateralReturnLovelace: decodedNewContract.collateralReturnLovelace.toString(),
								note: 'Option A (auto top-up) will handle this during result submission',
							});
						}
					} catch (minUtxoCheckError) {
						logger.warn('Failed to perform min-UTXO validation check', {
							paymentRequestId: dbEntry.id,
							error: minUtxoCheckError instanceof Error ? minUtxoCheckError.message : String(minUtxoCheckError),
						});
					}

					await prisma.paymentRequest.update({
						where: { id: dbEntry.id },
						data: {
							totalBuyerCardanoFees: { increment: buyerCardanoFees },
							totalSellerCardanoFees: { increment: sellerCardanoFees },
							collateralReturnLovelace: decodedNewContract.collateralReturnLovelace,
							ActionHistory: {
								connect: {
									id: dbEntry.nextActionId,
								},
							},
							NextAction: {
								create: {
									requestedAction: newAction,
									errorNote: errorNote.length > 0 ? errorNote.join(';\n ') : undefined,
								},
							},
							CurrentTransaction: dbEntry.currentTransactionId
								? {
										update: {
											txHash: tx.tx.tx_hash,
											status: TransactionStatus.Confirmed,
											confirmations: tx.block.confirmations,
											previousOnChainState: null,
											newOnChainState: newState,
											fees: metadata.fees ?? null,
											blockHeight: metadata.block_height,
											blockTime: metadata.block_time,
											outputAmount: JSON.stringify(metadata.output_amount),
											utxoCount: metadata.utxo_count,
											withdrawalCount: metadata.withdrawal_count,
											assetMintOrBurnCount: metadata.asset_mint_or_burn_count,
											redeemerCount: metadata.redeemer_count,
											validContract: metadata.valid_contract,
										},
									}
								: {
										create: {
											txHash: tx.tx.tx_hash,
											status: TransactionStatus.Confirmed,
											confirmations: tx.block.confirmations,
											previousOnChainState: null,
											newOnChainState: newState,
											fees: metadata.fees,
											blockHeight: metadata.block_height,
											blockTime: metadata.block_time,
											outputAmount: JSON.stringify(metadata.output_amount),
											utxoCount: metadata.utxo_count,
											withdrawalCount: metadata.withdrawal_count,
											assetMintOrBurnCount: metadata.asset_mint_or_burn_count,
											redeemerCount: metadata.redeemer_count,
											validContract: metadata.valid_contract,
										},
									},
							onChainState: newState,
							resultHash: decodedNewContract.resultHash,
							buyerReturnAddress:
								paymentContract.paymentSourceType === PaymentSourceType.Web3CardanoV2
									? decodedNewContract.buyerReturnAddress
									: undefined,
							sellerReturnAddress:
								paymentContract.paymentSourceType === PaymentSourceType.Web3CardanoV2
									? decodedNewContract.sellerReturnAddress
									: undefined,
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
					timeout: 30_000,
					maxWait: 30_000,
				},
			),
		{ label: 'tx-sync-handle-3' },
	);
}

/**
 * Process ONE input/output pair from a (possibly batched) smart-contract tx.
 *
 * Single-redeemer V1 txs call this once. Multi-redeemer V2 batch txs call
 * this N times (once per `ExtractedTransactionEntry` in
 * `extractedData.entries`). Each invocation maps to exactly one
 * `PaymentRequest` / `PurchaseRequest` row via the entry's
 * `decodedOldContract.blockchainIdentifier`.
 */
export async function updateTransaction(
	paymentContract: PaymentSource,
	entry: ExtractedTransactionEntry,
	blockfrost: BlockFrostAPI,
	tx: UpdateTransactionInput,
	beforeWrite?: TxSyncBeforeWrite,
) {
	// Look up the request by `blockchainIdentifier` only (single-field @unique).
	// Time-window and party-vkey fields are verified post-fetch with
	// null-tolerant equality so legacy rows predating the payByTime column
	// (added in migration 20250622215253_add_pay_by_time without a backfill,
	// schema declares `payByTime BigInt?`) are still picked up. Pre-fetch
	// equality on `payByTime: <bigint>` in `findUnique` would silently miss
	// rows with `payByTime IS NULL`, dropping confirmations for those rows.
	//
	// Spoofing defence is preserved: when the DB value is non-null and does
	// not match the on-chain datum, we log + return without writing through.
	let paymentRequest = await prisma.paymentRequest.findUnique({
		where: {
			blockchainIdentifier: entry.decodedOldContract.blockchainIdentifier,
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
	if (paymentRequest != null) {
		if (paymentRequest.paymentSourceId !== paymentContract.id) {
			// Row belongs to a different payment source. Ignore this side
			// during the current source's pass, but keep checking the purchase
			// side below in case it legitimately belongs here.
			logger.warn('tx-sync: ignoring payment request row from a different payment source', {
				txHash: tx.tx.tx_hash,
				blockchainIdentifier: entry.decodedOldContract.blockchainIdentifier,
				currentPaymentSourceId: paymentContract.id,
				requestPaymentSourceId: paymentRequest.paymentSourceId,
				paymentRequestId: paymentRequest.id,
			});
			paymentRequest = null;
		} else if (!verifyRequestFieldsAgainstDatum(paymentRequest, entry.decodedOldContract, 'payment', tx.tx.tx_hash)) {
			return;
		}
	}
	let purchasingRequest = await prisma.purchaseRequest.findUnique({
		where: {
			blockchainIdentifier: entry.decodedOldContract.blockchainIdentifier,
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
	if (purchasingRequest != null) {
		if (purchasingRequest.paymentSourceId !== paymentContract.id) {
			logger.warn('tx-sync: ignoring purchase request row from a different payment source', {
				txHash: tx.tx.tx_hash,
				blockchainIdentifier: entry.decodedOldContract.blockchainIdentifier,
				currentPaymentSourceId: paymentContract.id,
				requestPaymentSourceId: purchasingRequest.paymentSourceId,
				purchaseRequestId: purchasingRequest.id,
			});
			purchasingRequest = null;
		} else if (
			!verifyRequestFieldsAgainstDatum(purchasingRequest, entry.decodedOldContract, 'purchase', tx.tx.tx_hash)
		) {
			return;
		}
	}

	if (paymentRequest == null && purchasingRequest == null) {
		// Transaction is not registered with us or duplicated (therefore
		// invalid). WARN, not info: tx-sync's checkpoint advances past this
		// tx and we'll never re-evaluate it. If an operator later wires up a
		// matching request row (data migration, manual repair), they need
		// this signal to find the historical tx for manual replay.
		// Default log levels include warn; downgrading to info would hide
		// the signal under steady-state noise.
		logger.warn(
			'tx-sync: skipping tx — no matching request row for blockchainIdentifier (checkpoint will advance past this tx)',
			{
				txHash: tx.tx.tx_hash,
				blockchainIdentifier: entry.decodedOldContract.blockchainIdentifier,
				paymentSourceId: paymentContract.id,
				actionable:
					'If a request row is added later that maps to this blockchainIdentifier, replay the tx via the admin recovery path — tx-sync will not revisit it.',
			},
		);
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
		logger.warn('Input tx hash does not match payment request tx hash. This likely is a spoofing attempt', {
			paymentRequest: paymentRequest,
			txHash: tx.tx.tx_hash,
		});
	}
	const inputTxHashMatchPurchasingRequest = await checkIfTxIsInHistory(
		purchasingRequest?.CurrentTransaction?.txHash ?? 'no-tx',
		purchasingRequest?.TransactionHistory ?? [],
		blockfrost,
		paymentContract.smartContractAddress,
		tx,
	);
	if (inputTxHashMatchPurchasingRequest == false) {
		logger.warn('Input tx hash does not match purchasing request tx hash. This likely is a spoofing attempt', {
			purchasingRequest: purchasingRequest,
			txHash: tx.tx.tx_hash,
		});
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
		entry.valueOutput?.amount ?? [],
		entry.decodedOldContract.collateralReturnLovelace,
	);
	if (
		paymentContract.paymentSourceType === PaymentSourceType.Web3CardanoV2 &&
		entry.decodedNewContract != null &&
		!v2ReturnAddressesMatch(entry.decodedOldContract, entry.decodedNewContract)
	) {
		logger.warn('Return addresses changed in V2 contract datum. This likely is a spoofing attempt.', {
			txHash: tx.tx.tx_hash,
			oldBuyerReturnAddress: entry.decodedOldContract.buyerReturnAddress,
			newBuyerReturnAddress: entry.decodedNewContract.buyerReturnAddress,
			oldSellerReturnAddress: entry.decodedOldContract.sellerReturnAddress,
			newSellerReturnAddress: entry.decodedNewContract.sellerReturnAddress,
		});
		return;
	}

	const buyerCardanoFees = getCardanoFeesBuyer(
		entry.redeemerVersion,
		entry.feesShare,
		paymentContract.paymentSourceType,
	);
	const sellerCardanoFees = getCardanoFeesSeller(
		entry.redeemerVersion,
		entry.feesShare,
		paymentContract.paymentSourceType,
	);

	const newState: OnChainState | null = redeemerToOnChainState(
		entry.redeemerVersion,
		entry.decodedNewContract,
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
		sellerWithdrawn = calculateValueChange(tx.utxos.inputs, tx.utxos.outputs, entry.decodedOldContract.sellerVkey);

		buyerWithdrawn = calculateValueChange(tx.utxos.inputs, tx.utxos.outputs, entry.decodedOldContract.buyerVkey);
	}

	// Per-handler try/catch lets both halves run independently (an entry can
	// map to both a paymentRequest and a purchasingRequest), but a failure
	// in EITHER must propagate up so the outer tx-sync loop does NOT advance
	// the checkpoint past this tx. If we swallowed silently, the affected
	// request would stay stuck at its pre-tx state forever (no future sync
	// tick re-processes a tx whose checkpoint has already passed). The
	// handlers are idempotent on retry (see the early-return guards at the
	// top of each) so re-processing the whole tx next tick is safe.
	let paymentHandlerError: unknown;
	let purchasingHandlerError: unknown;
	// Exhaustive route by paymentSourceType. The `assertNever` default forces
	// adding a new PaymentSourceType enum value to be a TypeScript compile
	// error — without it, a future enum addition would silently advance the
	// tx-sync checkpoint while the new source's confirmations went unprocessed.
	let paymentHandler: typeof handleV1PaymentTransaction;
	let purchasingHandler: typeof handleV1PurchasingTransaction;
	switch (paymentContract.paymentSourceType) {
		case PaymentSourceType.Web3CardanoV1:
			paymentHandler = handleV1PaymentTransaction;
			purchasingHandler = handleV1PurchasingTransaction;
			break;
		case PaymentSourceType.Web3CardanoV2:
			paymentHandler = handleV2PaymentTransaction;
			purchasingHandler = handleV2PurchasingTransaction;
			break;
		default: {
			const _exhaustive: never = paymentContract.paymentSourceType;
			// Throw, do NOT silently return. The outer tx-sync loop catches
			// throws and HALTS the per-source checkpoint advance, which is
			// the only safe outcome here: a new PaymentSourceType variant
			// added to Prisma without a matching handler arm above would
			// otherwise silently skip confirmation processing for that
			// source's txs while the checkpoint advanced past them
			// — irrecoverable without a re-sync from scratch.
			throw new Error(
				`Unsupported paymentSourceType '${String(_exhaustive)}' for tx-sync confirmation handlers; checkpoint advance HALTED to prevent silent skip. tx_hash=${tx.tx.tx_hash}`,
			);
		}
	}
	try {
		if (inputTxHashMatchPaymentRequest) {
			// NOTE: NextAction.requestedAction is intentionally NOT passed — the
			// handler re-reads it inside its Serializable tx to avoid the stale-
			// predecessor race where a batch service pre-submit could swap it
			// between this outer read and the handler's tx open.
			await paymentHandler(
				tx.tx.tx_hash,
				newState,
				paymentContract.id,
				entry.decodedOldContract.blockchainIdentifier,
				entry.decodedNewContract?.resultHash ?? entry.decodedOldContract.resultHash,
				entry.decodedNewContract?.buyerCooldownTime ?? 0n,
				entry.decodedNewContract?.sellerCooldownTime ?? 0n,
				sellerWithdrawn,
				buyerWithdrawn,
				tx.block.confirmations,
				tx.metadata,
				buyerCardanoFees,
				sellerCardanoFees,
				beforeWrite,
			);
		}
	} catch (error) {
		paymentHandlerError = error;
		logger.error('Error handling payment transaction', {
			error: error,
		});
	}
	try {
		if (inputTxHashMatchPurchasingRequest) {
			await purchasingHandler(
				tx.tx.tx_hash,
				newState,
				paymentContract.id,
				entry.decodedOldContract.blockchainIdentifier,
				entry.decodedNewContract?.resultHash ?? entry.decodedOldContract.resultHash,
				entry.decodedNewContract?.buyerCooldownTime ?? 0n,
				entry.decodedNewContract?.sellerCooldownTime ?? 0n,
				sellerWithdrawn,
				buyerWithdrawn,
				tx.block.confirmations,
				tx.metadata,
				buyerCardanoFees,
				sellerCardanoFees,
				beforeWrite,
			);
		}
	} catch (error) {
		purchasingHandlerError = error;
		logger.error('Error handling purchasing transaction', {
			error: error,
		});
	}
	// Both handlers ran independently. When BOTH failed, surface both
	// causes via AggregateError so the outer scheduler log captures the
	// payment-side AND purchase-side error chains. Previously the second
	// throw discarded the payment-side error and operators had to
	// reconstruct half the failure from earlier log lines.
	if (paymentHandlerError != null && purchasingHandlerError != null) {
		throw new AggregateError(
			[paymentHandlerError, purchasingHandlerError],
			'Both payment-side and purchase-side handlers failed for tx-sync entry',
		);
	}
	if (paymentHandlerError != null) {
		throw paymentHandlerError as Error;
	}
	if (purchasingHandlerError != null) {
		throw purchasingHandlerError as Error;
	}
}
