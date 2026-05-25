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
import { retryOnSerializationConflict } from '@/utils/db/retry';
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

function v2ReturnAddressesMatch(left: DecodedV1ContractDatum, right: DecodedV1ContractDatum) {
	return (
		nullableStringEquals(left.buyerReturnAddress, right.buyerReturnAddress) &&
		nullableStringEquals(left.sellerReturnAddress, right.sellerReturnAddress)
	);
}

export async function updateRolledBackTransaction(rolledBackTx: Array<{ tx_hash: string }>) {
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
							await innerTx.transaction.update({
								where: { id: transaction.id },
								data: {
									status: TransactionStatus.RolledBack,
									BlocksWallet: transaction.BlocksWallet ? { disconnect: true } : undefined,
								},
							});
							if (transaction.BlocksWallet != null) {
								await innerTx.hotWallet.update({
									where: { id: transaction.BlocksWallet.id },
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
								...transaction.PaymentRequestCurrent.map((pr) => ({
									id: pr.id,
									nextActionId: pr.nextActionId,
								})),
								...transaction.PaymentRequestHistory.map((pr) => ({
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
								...transaction.PurchaseRequestCurrent.map((pr) => ({
									id: pr.id,
									nextActionId: pr.nextActionId,
								})),
								...transaction.PurchaseRequestHistory.map((pr) => ({
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
						{ timeout: 30_000 },
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
) {
	await retryOnSerializationConflict(
		() =>
			prisma.$transaction(
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

					const dbEntry = await prisma.purchaseRequest.findFirst({
						where: {
							blockchainIdentifier: decodedNewContract.blockchainIdentifier,
							paymentSourceId: paymentContract.id,
							NextAction: {
								requestedAction: {
									in: [PurchasingAction.FundsLockingInitiated],
								},
							},
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
						//transaction is not registered with us
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
					if (output.reference_script_hash != null) {
						//no reference script allowed
						logger.warn('Reference script hash is not null, this should not be set', {
							tx: tx.tx.tx_hash,
						});
						return;
					}
					if (dbEntry.inputHash !== decodedNewContract.inputHash) {
						logger.error(
							'Purchase request input hash does not match input hash in contract. This is likely a spoofing attempt.',
							{
								purchaseRequest: dbEntry,
								inputHash: dbEntry.inputHash,
								inputHashContract: decodedNewContract.inputHash,
							},
						);
						return;
					}

					//We soft ignore those transactions
					if (
						decodedNewContract.sellerVkey != dbEntry.SellerWallet.walletVkey ||
						decodedNewContract.sellerAddress != dbEntry.SellerWallet.walletAddress
					) {
						logger.warn('Seller does not match seller in db. This likely is a spoofing attempt.', {
							purchaseRequest: dbEntry,
							sender: decodedNewContract.sellerVkey,
							senderAddress: decodedNewContract.sellerAddress,
							senderDb: dbEntry.SmartContractWallet?.walletVkey,
							senderDbAddress: dbEntry.SmartContractWallet?.walletAddress,
						});
						return;
					}
					if (tx.utxos.inputs.find((x) => x.address == decodedNewContract.buyerAddress) == null) {
						logger.warn('Buyer address not found in inputs, this likely is a spoofing attempt.', {
							purchaseRequest: dbEntry,
							buyerAddress: decodedNewContract.buyerAddress,
						});
						return;
					}

					if (BigInt(decodedNewContract.collateralReturnLovelace) != dbEntry.collateralReturnLovelace) {
						logger.warn(
							'Collateral return lovelace does not match collateral return lovelace in db. This likely is a spoofing attempt.',
							{
								purchaseRequest: dbEntry,
								collateralReturnLovelace: decodedNewContract.collateralReturnLovelace,
								collateralReturnLovelaceDb: dbEntry.collateralReturnLovelace,
							},
						);
						return;
					}

					if (BigInt(decodedNewContract.payByTime) != dbEntry.payByTime) {
						logger.warn('Pay by time does not match pay by time in db. This likely is a spoofing attempt.', {
							purchaseRequest: dbEntry,
						});
						return;
					}

					const blockTime = tx.blockTime;
					if (blockTime * 1000 > decodedNewContract.payByTime) {
						logger.warn('Block time is after pay by time. This is a timed out purchase.', {
							purchaseRequest: dbEntry,
							blockTime: blockTime * 1000,
							payByTime: decodedNewContract.payByTime,
						});
						return;
					}

					const expectedBuyerVkey = dbEntry.SmartContractWallet?.walletVkey;
					const expectedBuyerAddress = dbEntry.SmartContractWallet?.walletAddress;
					const isBuyerVkeyMismatch = expectedBuyerVkey != null && decodedNewContract.buyerVkey !== expectedBuyerVkey;
					const isBuyerAddressMismatch =
						expectedBuyerAddress != null && decodedNewContract.buyerAddress !== expectedBuyerAddress;
					if (isBuyerVkeyMismatch || isBuyerAddressMismatch) {
						logger.warn('Buyer does not match buyer in db. This likely is a spoofing attempt.', {
							purchaseRequest: dbEntry,
							buyer: decodedNewContract.buyerVkey,
							buyerAddress: decodedNewContract.buyerAddress,
							buyerDb: expectedBuyerVkey,
							buyerDbAddress: expectedBuyerAddress,
						});
						return;
					}
					if (decodedNewContract.state != SmartContractState.FundsLocked) {
						logger.warn('State is not funds locked. This likely is a spoofing attempt.', {
							purchaseRequest: dbEntry,
							state: decodedNewContract.state,
						});
						return;
					}
					if (decodedNewContract.resultHash != null) {
						logger.warn('Result hash was set. This likely is a spoofing attempt.', {
							purchaseRequest: dbEntry,
							resultHash: decodedNewContract.resultHash,
						});
						return;
					}
					if (BigInt(decodedNewContract.resultTime) != dbEntry.submitResultTime) {
						logger.warn('Result time is not the agreed upon time. This likely is a spoofing attempt.', {
							purchaseRequest: dbEntry,
							resultTime: decodedNewContract.resultTime,
							resultTimeDb: dbEntry.submitResultTime,
						});
						return;
					}
					if (decodedNewContract.unlockTime < dbEntry.unlockTime) {
						logger.warn('Unlock time is before the agreed upon time. This likely is a spoofing attempt.', {
							purchaseRequest: dbEntry,
							unlockTime: decodedNewContract.unlockTime,
							unlockTimeDb: dbEntry.unlockTime,
						});
						return;
					}
					if (BigInt(decodedNewContract.externalDisputeUnlockTime) != dbEntry.externalDisputeUnlockTime) {
						logger.warn(
							'External dispute unlock time is not the agreed upon time. This likely is a spoofing attempt.',
							{
								purchaseRequest: dbEntry,
								externalDisputeUnlockTime: decodedNewContract.externalDisputeUnlockTime,
								externalDisputeUnlockTimeDb: dbEntry.externalDisputeUnlockTime,
							},
						);
						return;
					}
					if (BigInt(decodedNewContract.buyerCooldownTime) != BigInt(0)) {
						logger.warn('Buyer cooldown time is not 0. This likely is a spoofing attempt.', {
							purchaseRequest: dbEntry,
							buyerCooldownTime: decodedNewContract.buyerCooldownTime,
						});
						return;
					}
					if (BigInt(decodedNewContract.sellerCooldownTime) != BigInt(0)) {
						logger.warn('Seller cooldown time is not 0. This likely is a spoofing attempt.', {
							purchaseRequest: dbEntry,
							sellerCooldownTime: decodedNewContract.sellerCooldownTime,
						});
						return;
					}
					if (
						paymentContract.paymentSourceType === PaymentSourceType.Web3CardanoV2 &&
						(!nullableStringEquals(decodedNewContract.buyerReturnAddress, dbEntry.buyerReturnAddress) ||
							!nullableStringEquals(decodedNewContract.sellerReturnAddress, dbEntry.sellerReturnAddress))
					) {
						logger.warn('Return addresses do not match return addresses in db. This likely is a spoofing attempt.', {
							purchaseRequest: dbEntry,
							buyerReturnAddress: decodedNewContract.buyerReturnAddress,
							buyerReturnAddressDb: dbEntry.buyerReturnAddress,
							sellerReturnAddress: decodedNewContract.sellerReturnAddress,
							sellerReturnAddressDb: dbEntry.sellerReturnAddress,
						});
						return;
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
									requestedAction: PurchasingAction.WaitingForExternalAction,
								},
							},
							CurrentTransaction: dbEntry.currentTransactionId
								? {
										update: {
											txHash: tx.tx.tx_hash,
											status: TransactionStatus.Confirmed,
											confirmations: tx.block.confirmations,
											previousOnChainState: null,
											newOnChainState: OnChainState.FundsLocked,
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
											newOnChainState: OnChainState.FundsLocked,
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
							onChainState: OnChainState.FundsLocked,
							resultHash: decodedNewContract.resultHash,
						},
					});
					if (
						dbEntry.currentTransactionId != null &&
						dbEntry.CurrentTransaction?.BlocksWallet != null &&
						dbEntry.SmartContractWallet != null
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
) {
	await retryOnSerializationConflict(
		() =>
			prisma.$transaction(
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
						logger.warn('Buyer address not found in inputs, this likely is a spoofing attempt.', {
							paymentRequest: dbEntry,
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
) {
	const paymentRequest = await prisma.paymentRequest.findUnique({
		where: {
			paymentSourceId: paymentContract.id,
			blockchainIdentifier: entry.decodedOldContract.blockchainIdentifier,
			payByTime: entry.decodedOldContract.payByTime,
			submitResultTime: entry.decodedOldContract.resultTime,
			unlockTime: entry.decodedOldContract.unlockTime,
			externalDisputeUnlockTime: entry.decodedOldContract.externalDisputeUnlockTime,
			BuyerWallet: {
				walletVkey: entry.decodedOldContract.buyerVkey,
				walletAddress: entry.decodedOldContract.buyerAddress,
			},
			SmartContractWallet: {
				walletVkey: entry.decodedOldContract.sellerVkey,
				walletAddress: entry.decodedOldContract.sellerAddress,
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
			blockchainIdentifier: entry.decodedOldContract.blockchainIdentifier,
			payByTime: entry.decodedOldContract.payByTime,
			submitResultTime: entry.decodedOldContract.resultTime,
			unlockTime: entry.decodedOldContract.unlockTime,
			externalDisputeUnlockTime: entry.decodedOldContract.externalDisputeUnlockTime,
			SellerWallet: {
				walletVkey: entry.decodedOldContract.sellerVkey,
				walletAddress: entry.decodedOldContract.sellerAddress,
			},
			SmartContractWallet: {
				walletVkey: entry.decodedOldContract.buyerVkey,
				walletAddress: entry.decodedOldContract.buyerAddress,
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
			logger.error(
				'Unsupported paymentSourceType for tx-sync confirmation handlers (tsc should have caught this). Skipping. tx_hash: ' +
					tx.tx.tx_hash,
				{ paymentSourceType: _exhaustive },
			);
			return;
		}
	}
	try {
		if (inputTxHashMatchPaymentRequest) {
			await paymentHandler(
				tx.tx.tx_hash,
				newState,
				paymentContract.id,
				entry.decodedOldContract.blockchainIdentifier,
				entry.decodedNewContract?.resultHash ?? entry.decodedOldContract.resultHash,
				paymentRequest?.NextAction?.requestedAction ?? PaymentAction.None,
				entry.decodedNewContract?.buyerCooldownTime ?? 0n,
				entry.decodedNewContract?.sellerCooldownTime ?? 0n,
				sellerWithdrawn,
				buyerWithdrawn,
				tx.block.confirmations,
				tx.metadata,
				buyerCardanoFees,
				sellerCardanoFees,
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
				purchasingRequest?.NextAction?.requestedAction ?? PurchasingAction.None,
				entry.decodedNewContract?.buyerCooldownTime ?? 0n,
				entry.decodedNewContract?.sellerCooldownTime ?? 0n,
				sellerWithdrawn,
				buyerWithdrawn,
				tx.block.confirmations,
				tx.metadata,
				buyerCardanoFees,
				sellerCardanoFees,
			);
		}
	} catch (error) {
		purchasingHandlerError = error;
		logger.error('Error handling purchasing transaction', {
			error: error,
		});
	}
	if (paymentHandlerError != null) {
		throw paymentHandlerError as Error;
	}
	if (purchasingHandlerError != null) {
		throw purchasingHandlerError as Error;
	}
}
