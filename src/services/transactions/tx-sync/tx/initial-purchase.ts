import { prisma } from '@masumi/payment-core/db';
import { SmartContractState } from '@/utils/generator/contract-generator';
import { logger } from '@masumi/payment-core/logger';
import {
	Network,
	OnChainState,
	PaymentSourceType,
	Prisma,
	PurchaseErrorType,
	PurchasingAction,
	TransactionStatus,
} from '@/generated/prisma/client';
import { ExtractOnChainTransactionDataOutput } from '@/services/transactions/tx-sync/util';
import { DecodedV1ContractDatum } from '@/utils/converter/string-datum-convert';
import { TransactionMetadata } from '@/services/transactions/tx-sync/blockchain';
import { withSerializableSlotRetry } from '@masumi/payment-core/serializable-semaphore';
import { TxSyncBeforeWrite } from '../quarantine/fenced-write';
import { reportInitialLockWithoutPurchaseRow } from './missing-purchase-row';
import { canL1ObservationOwnPurchaseRequest } from '@/utils/logic/force-layer';
import type { UpdateTransactionInput } from './types';
import { nullableStringEquals } from './datum-verification';

export async function updateInitialPurchaseTransaction(
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
	let hasNoPurchaseRow = false;
	await withSerializableSlotRetry(
		() =>
			prisma.$transaction(
				async (prisma) => {
					hasNoPurchaseRow = false;
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
						hasNoPurchaseRow = true;
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
					if (!canL1ObservationOwnPurchaseRequest(dbEntry)) {
						logger.info('tx-sync: ignoring L1 initial output for Hydra-owned or Hydra-forced purchase', {
							txHash: tx.tx.tx_hash,
							purchaseRequestId: dbEntry.id,
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
	if (hasNoPurchaseRow) {
		await reportInitialLockWithoutPurchaseRow(prisma, {
			txHash: tx.tx.tx_hash,
			paymentSourceId: paymentContract.id,
			blockchainIdentifier: decodedNewContract.blockchainIdentifier,
			buyerVkey: decodedNewContract.buyerVkey,
		});
	}
}
