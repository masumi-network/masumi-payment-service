import { PaymentSourceType, PurchasingAction, PurchaseErrorType, Prisma } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { deserializeDatum } from '@meshsdk/core';
import type { BlockfrostProvider } from '@/services/shared';
import { logger } from '@masumi/payment-core/logger';
import { SmartContractState, smartContractStateEqualsOnChainState } from '@/utils/generator/contract-generator';
import { convertNetwork } from '@/utils/converter/network-convert';
import { newCooldownTime } from '@/utils/converter/string-datum-convert';
import { lockAndQueryPurchases } from '@/utils/db/lock-and-query-purchases';
import { interpretBlockchainError } from '@/utils/errors/blockchain-error-interpreter';
import { advancedRetryAll, delayErrorResolver } from 'advanced-retry';
import { sortAndLimitUtxos } from '@/utils/utxo';
import { Mutex, MutexInterface, tryAcquire } from 'async-mutex';
import { generateMasumiSmartContractInteractionTransactionAutomaticFees } from '@/utils/generator/transaction-generator';
import {
	connectPreviousAction,
	createMeshProvider,
	createNextPurchaseAction,
	createPendingTransaction,
	createTxWindow,
	loadHotWalletSession,
	updateCurrentTransactionHash,
} from '@/services/shared';
import { createDatumFromDecodedContractV2, getPaymentScriptFromPaymentSourceV2 } from '@masumi/payment-source-v2';
import { decodeV2ContractDatum } from '@/utils/converter/string-datum-convert';

type PaymentSourceWithPurchaseRelations = Prisma.PaymentSourceGetPayload<{
	include: {
		PurchaseRequests: {
			include: {
				NextAction: true;
				CurrentTransaction: true;
				PaidFunds: true;
				SellerWallet: true;
				SmartContractWallet: {
					include: {
						Secret: true;
					};
				};
			};
		};
		AdminWallets: true;
		FeeReceiverNetworkWallet: true;
		PaymentSourceConfig: true;
	};
}>;

// Extract PurchaseRequest type from PaymentSource
type PurchaseRequestWithRelations = PaymentSourceWithPurchaseRelations['PurchaseRequests'][number];

const mutex = new Mutex();

async function processSinglePurchaseRequest(
	request: PurchaseRequestWithRelations,
	paymentContract: PaymentSourceWithPurchaseRelations,
	blockchainProvider: BlockfrostProvider,
	network: 'mainnet' | 'preprod',
): Promise<boolean> {
	if (request.payByTime == null) {
		throw new Error('Pay by time is null, this is deprecated');
	}
	if (request.collateralReturnLovelace == null) {
		throw new Error('Collateral return lovelace is null, this is deprecated');
	}
	const purchasingWallet = request.SmartContractWallet;
	if (purchasingWallet == null) throw new Error('Purchasing wallet not found');
	const encryptedSecret = purchasingWallet.Secret.encryptedMnemonic;

	const walletSession = await loadHotWalletSession({
		network: paymentContract.network,
		rpcProviderApiKey: paymentContract.PaymentSourceConfig.rpcProviderApiKey,
		encryptedMnemonic: encryptedSecret,
		hotWalletId: purchasingWallet.id,
	});
	const { wallet, utxos, address } = walletSession;
	if (utxos.length === 0) {
		//this is if the seller wallet is empty
		throw new Error('No UTXOs found in the wallet. Wallet is empty.');
	}

	const { script, smartContractAddress } = await getPaymentScriptFromPaymentSourceV2(paymentContract);

	const txHash = request.CurrentTransaction?.txHash;
	if (txHash == null) {
		throw new Error('Transaction hash not found');
	}
	const utxoByHash = await blockchainProvider.fetchUTxOs(txHash);

	const utxo = utxoByHash.find((utxo) => {
		if (utxo.input.txHash != txHash) {
			return false;
		}
		const utxoDatum = utxo.output.plutusData;
		if (!utxoDatum) {
			return false;
		}

		const decodedDatum: unknown = deserializeDatum(utxoDatum);
		const decodedContract = decodeV2ContractDatum(decodedDatum, network, smartContractAddress);
		if (decodedContract == null) {
			return false;
		}

		return (
			smartContractStateEqualsOnChainState(decodedContract.state, request.onChainState) &&
			decodedContract.buyerVkey == request.SmartContractWallet!.walletVkey &&
			decodedContract.sellerVkey == request.SellerWallet.walletVkey &&
			decodedContract.buyerAddress == request.SmartContractWallet!.walletAddress &&
			decodedContract.sellerAddress == request.SellerWallet.walletAddress &&
			decodedContract.blockchainIdentifier == request.blockchainIdentifier &&
			decodedContract.inputHash == request.inputHash &&
			BigInt(decodedContract.resultTime) == BigInt(request.submitResultTime) &&
			BigInt(decodedContract.unlockTime) == BigInt(request.unlockTime) &&
			BigInt(decodedContract.externalDisputeUnlockTime) == BigInt(request.externalDisputeUnlockTime) &&
			BigInt(decodedContract.collateralReturnLovelace) == BigInt(request.collateralReturnLovelace!) &&
			BigInt(decodedContract.payByTime) == BigInt(request.payByTime!)
		);
	});

	if (!utxo) {
		throw new Error('UTXO not found');
	}

	const utxoDatum = utxo.output.plutusData;
	if (!utxoDatum) {
		throw new Error('No datum found in UTXO');
	}

	const decodedDatum: unknown = deserializeDatum(utxoDatum);
	const decodedContract = decodeV2ContractDatum(decodedDatum, network, smartContractAddress);
	if (decodedContract == null) {
		throw new Error('Invalid datum');
	}
	// Aiken SetRefundRequested requires every field of the continuation datum
	// (including buyer/seller addresses AND return addresses) to equal the
	// decoded input's values. Mirror chain state to avoid DB drift failing the
	// validator. Other rewrite-able fields stay nulled via createDatumFromDecodedContractV2.
	const datum = createDatumFromDecodedContractV2({
		decodedContract,
		buyerAddress: decodedContract.buyerAddress,
		buyerReturnAddress: decodedContract.buyerReturnAddress,
		sellerAddress: decodedContract.sellerAddress,
		sellerReturnAddress: decodedContract.sellerReturnAddress,
		blockchainIdentifier: request.blockchainIdentifier,
		resultHash: decodedContract.resultHash,
		newCooldownTimeSeller: BigInt(0),
		newCooldownTimeBuyer: newCooldownTime(BigInt(paymentContract.cooldownTime)),
		state:
			decodedContract.resultHash == null || decodedContract.resultHash == ''
				? SmartContractState.RefundRequested
				: SmartContractState.Disputed,
	});

	const { invalidBefore, invalidAfter } = createTxWindow(network, {
		constrainAfterMs: Number(decodedContract.unlockTime),
	});

	const limitedFilteredUtxos = sortAndLimitUtxos(utxos, 8000000);
	const collateralUtxo = limitedFilteredUtxos[0];
	if (collateralUtxo == null) {
		throw new Error('Collateral UTXO not found');
	}

	const unsignedTx = await generateMasumiSmartContractInteractionTransactionAutomaticFees(
		'RequestRefund',
		blockchainProvider,
		network,
		script,
		address,
		utxo,
		limitedFilteredUtxos[0],
		limitedFilteredUtxos,
		datum.value,
		invalidBefore,
		invalidAfter,
		paymentContract.PaymentSourceConfig.rpcProviderApiKey,
	);

	const signedTx = await wallet.signTx(unsignedTx);

	await prisma.purchaseRequest.update({
		where: { id: request.id },
		data: {
			...connectPreviousAction(request.nextActionId),
			...createNextPurchaseAction(PurchasingAction.SetRefundRequestedInitiated),
			...createPendingTransaction(purchasingWallet.id),
			TransactionHistory: {
				connect: {
					id: request.CurrentTransaction!.id,
				},
			},
		},
	});

	//submit the transaction to the blockchain
	const newTxHash = await wallet.submitTx(signedTx);
	await walletSession.evaluateProjectedBalance(unsignedTx, limitedFilteredUtxos);
	await prisma.purchaseRequest.update({
		where: { id: request.id },
		data: updateCurrentTransactionHash(newTxHash),
	});

	logger.debug(`Created refund request transaction:
                  Tx ID: ${txHash}
                  View (after a bit) on https://${
										network === 'preprod' ? 'preprod.' : ''
									}cardanoscan.io/transaction/${txHash}
                  Smart Contract Address: ${smartContractAddress}
              `);
	return true;
}

export async function requestRefundsV2() {
	let release: MutexInterface.Releaser | null;
	try {
		release = await tryAcquire(mutex).acquire();
	} catch (e) {
		logger.info('Mutex timeout when locking', { error: e });
		return;
	}

	try {
		const paymentContractsWithWalletLocked = await lockAndQueryPurchases({
			purchasingAction: PurchasingAction.SetRefundRequestedRequested,
			// Aiken `must_end_before(unlock_time)` requires the tx validity upper
			// bound to be strictly less than unlock_time. The tx-window builder
			// (createTxWindow with default ~2.5min buffer + slot buffer) cannot
			// honor that constraint once unlock_time is within ~3 minutes of
			// now. Filter to leave a comfortable margin so submissions don't
			// hit the ledger boundary and fail with `OutsideValidityIntervalUTxO`.
			unlockTime: { gt: Date.now() + 1000 * 60 * 3 },
			maxBatchSize: 1,
			paymentSourceType: PaymentSourceType.Web3CardanoV2,
		});

		await Promise.allSettled(
			paymentContractsWithWalletLocked.map(async (paymentContract) => {
				if (paymentContract.PurchaseRequests.length == 0) return;

				const network = convertNetwork(paymentContract.network);

				logger.info(
					`Requesting ${paymentContract.PurchaseRequests.length} refunds for payment source ${paymentContract.id}`,
				);
				const blockchainProvider = createMeshProvider(paymentContract.PaymentSourceConfig.rpcProviderApiKey);

				const purchaseRequests = paymentContract.PurchaseRequests;

				if (purchaseRequests.length == 0) return;
				const results = await advancedRetryAll({
					errorResolvers: [
						delayErrorResolver({
							configuration: {
								maxRetries: 5,
								backoffMultiplier: 5,
								initialDelayMs: 500,
								maxDelayMs: 7500,
							},
						}),
					],
					operations: purchaseRequests.map(
						(request) => async () =>
							processSinglePurchaseRequest(request, paymentContract, blockchainProvider, network),
					),
				});

				let index = 0;
				for (const result of results) {
					const request = purchaseRequests[index];
					if (result.success == false || result.result != true) {
						const error = result.error;
						logger.error(`Error requesting refund ${request.id}`, {
							error: error,
						});
						await prisma.purchaseRequest.update({
							where: { id: request.id },
							data: {
								...connectPreviousAction(request.nextActionId),
								...createNextPurchaseAction(PurchasingAction.WaitingForManualAction, {
									errorType: PurchaseErrorType.Unknown,
									errorNote: 'Requesting refund failed: ' + interpretBlockchainError(error),
								}),
								SmartContractWallet: {
									update: {
										lockedAt: null,
									},
								},
							},
						});
					}
					index++;
				}
			}),
		);
	} catch (error) {
		logger.error('Error collecting timeout refunds', { error: error });
	} finally {
		release();
	}
}
