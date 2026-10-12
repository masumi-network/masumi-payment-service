import { prisma } from '@masumi/payment-core/db';
import { SmartContractState } from '@/utils/generator/contract-generator';
import { logger } from '@masumi/payment-core/logger';
import {
	Network,
	OnChainState,
	PaymentAction,
	PaymentErrorType,
	PaymentSourceType,
	Prisma,
	TransactionStatus,
	WalletType,
} from '@/generated/prisma/client';
import { checkPaymentAmountsMatch, ExtractOnChainTransactionDataOutput } from '@/services/transactions/tx-sync/util';
import { DecodedV1ContractDatum } from '@/utils/converter/string-datum-convert';
import { CONSTANTS } from '@masumi/payment-core/config';
import { TransactionMetadata } from '@/services/transactions/tx-sync/blockchain';
import { calculateMinUtxo, getLovelaceFromAmounts, getNativeTokenCount, DUMMY_RESULT_HASH } from '@/utils/min-utxo';
import { getBlockfrostInstance } from '@/utils/blockfrost';
import { getPaymentSourceContractAdapter } from '@/services/payment-source-adapters';
import { withSerializableSlotRetry } from '@masumi/payment-core/serializable-semaphore';
import { TxSyncBeforeWrite } from '../quarantine/fenced-write';
import { canL1ObservationOwnPaymentRequest } from '@/utils/logic/force-layer';
import type { UpdateTransactionInput } from './types';
import { nullableStringEquals } from './datum-verification';

export async function updateInitialPaymentTransaction(
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
					if (!canL1ObservationOwnPaymentRequest(dbEntry)) {
						logger.info('tx-sync: ignoring L1 initial output for Hydra-owned or Hydra-forced payment', {
							txHash: tx.tx.tx_hash,
							paymentRequestId: dbEntry.id,
						});
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
