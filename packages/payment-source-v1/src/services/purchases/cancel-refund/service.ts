import { OnChainState, PaymentSourceType, PurchaseErrorType, PurchasingAction } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { deserializeDatum, UTxO } from '@meshsdk/core';
import { logger } from '@masumi/payment-core/logger';
import { SmartContractState, smartContractStateEqualsOnChainState } from '@/utils/generator/contract-generator';
import { convertNetwork } from '@/utils/converter/network-convert';
import { DecodedV1ContractDatum, decodeV1ContractDatum, newCooldownTime } from '@/utils/converter/string-datum-convert';
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
import { createDatumFromDecodedContractV1, getPaymentScriptFromPaymentSourceV1 } from '@masumi/payment-source-v1';

const mutex = new Mutex();

function validatePurchaseRequestFields(request: {
	payByTime: bigint | null;
	collateralReturnLovelace: bigint | null;
	CurrentTransaction: { txHash: string | null } | null;
	SmartContractWallet: object | null;
}): void {
	if (request.payByTime == null) {
		throw new Error('Pay by time is null, this is deprecated');
	}
	if (request.collateralReturnLovelace == null) {
		throw new Error('Collateral return lovelace is null, this is deprecated');
	}
	if (request.CurrentTransaction?.txHash == null) {
		throw new Error('Transaction hash not found');
	}
	if (request.SmartContractWallet == null) {
		throw new Error('Purchasing wallet not found');
	}
}

function decodeAndValidateUtxoDatum(params: {
	utxo: UTxO;
	network: 'mainnet' | 'preprod' | 'testnet' | 'preview';
}): DecodedV1ContractDatum {
	const utxoDatum = params.utxo.output.plutusData;
	if (!utxoDatum) {
		throw new Error('No datum found in UTXO');
	}
	const decodedDatum: unknown = deserializeDatum(utxoDatum);
	const decodedContract = decodeV1ContractDatum(decodedDatum, params.network);
	if (decodedContract == null) {
		throw new Error('Invalid datum');
	}
	return decodedContract;
}

function createCancelRefundDatum(params: {
	decodedContract: DecodedV1ContractDatum;
	buyerAddress: string;
	sellerAddress: string;
	blockchainIdentifier: string;
	cooldownTime: bigint;
}) {
	const hasResult = params.decodedContract.resultHash != null && params.decodedContract.resultHash != '';
	return createDatumFromDecodedContractV1({
		decodedContract: params.decodedContract,
		buyerAddress: params.buyerAddress,
		sellerAddress: params.sellerAddress,
		blockchainIdentifier: params.blockchainIdentifier,
		resultHash: params.decodedContract.resultHash,
		newCooldownTimeSeller: BigInt(0),
		newCooldownTimeBuyer: newCooldownTime(params.cooldownTime),
		state: hasResult ? SmartContractState.ResultSubmitted : SmartContractState.FundsLocked,
	});
}

export async function cancelRefundsV1() {
	let release: MutexInterface.Releaser | null;
	try {
		release = await tryAcquire(mutex).acquire();
	} catch (e) {
		logger.info('Mutex timeout when locking', { error: e });
		return;
	}

	try {
		const paymentContractsWithWalletLocked = await lockAndQueryPurchases({
			purchasingAction: PurchasingAction.UnSetRefundRequestedRequested,
			onChainState: { in: [OnChainState.Disputed, OnChainState.RefundRequested] },
			maxBatchSize: 1,
			paymentSourceType: PaymentSourceType.Web3CardanoV1,
		});

		await Promise.allSettled(
			paymentContractsWithWalletLocked.map(async (paymentContract) => {
				if (paymentContract.PurchaseRequests.length == 0) return;

				const network = convertNetwork(paymentContract.network);
				logger.info(
					`Cancelling ${paymentContract.PurchaseRequests.length} V1 refunds for payment source ${paymentContract.id}`,
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
					operations: purchaseRequests.map((request) => async () => {
						validatePurchaseRequestFields(request);
						const purchasingWallet = request.SmartContractWallet!;
						const encryptedSecret = purchasingWallet.Secret.encryptedMnemonic;
						const walletSession = await loadHotWalletSession({
							network: paymentContract.network,
							rpcProviderApiKey: paymentContract.PaymentSourceConfig.rpcProviderApiKey,
							encryptedMnemonic: encryptedSecret,
							hotWalletId: purchasingWallet.id,
						});
						const { wallet, utxos, address } = walletSession;
						if (utxos.length === 0) {
							throw new Error('No UTXOs found in the wallet. Wallet is empty.');
						}

						const { script, smartContractAddress } = await getPaymentScriptFromPaymentSourceV1(paymentContract);
						const txHash = request.CurrentTransaction?.txHash;
						if (txHash == null) {
							throw new Error('Transaction hash not found');
						}
						const utxoByHash = await blockchainProvider.fetchUTxOs(txHash);
						const utxo = utxoByHash.find((utxo) => {
							if (utxo.input.txHash != txHash) return false;
							const utxoDatum = utxo.output.plutusData;
							if (!utxoDatum) return false;
							const decodedDatum: unknown = deserializeDatum(utxoDatum);
							const decodedContract = decodeV1ContractDatum(decodedDatum, network);
							if (decodedContract == null) return false;
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
								BigInt(decodedContract.collateralReturnLovelace) == BigInt(request.collateralReturnLovelace ?? 0) &&
								BigInt(decodedContract.payByTime) == BigInt(request.payByTime ?? 0)
							);
						});
						if (!utxo) {
							throw new Error('UTXO not found');
						}

						const decodedContract = decodeAndValidateUtxoDatum({ utxo, network });
						const datum = createCancelRefundDatum({
							decodedContract,
							buyerAddress: request.SmartContractWallet!.walletAddress,
							sellerAddress: request.SellerWallet.walletAddress,
							blockchainIdentifier: request.blockchainIdentifier,
							cooldownTime: BigInt(paymentContract.cooldownTime),
						});

						const { invalidBefore, invalidAfter } = createTxWindow(network);
						const limitedFilteredUtxos = sortAndLimitUtxos(utxos, 8000000);

						const unsignedTx = await generateMasumiSmartContractInteractionTransactionAutomaticFees(
							'CancelRefund',
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
						);
						const signedTx = await wallet.signTx(unsignedTx);

						await prisma.purchaseRequest.update({
							where: { id: request.id },
							data: {
								...connectPreviousAction(request.nextActionId),
								...createNextPurchaseAction(PurchasingAction.UnSetRefundRequestedInitiated),
								...createPendingTransaction(purchasingWallet.id),
								TransactionHistory: { connect: { id: request.CurrentTransaction!.id } },
							},
						});

						const newTxHash = await wallet.submitTx(signedTx);
						await walletSession.evaluateProjectedBalance(unsignedTx, limitedFilteredUtxos);
						await prisma.purchaseRequest.update({
							where: { id: request.id },
							data: updateCurrentTransactionHash(newTxHash),
						});

						logger.debug(`Created V1 cancel-refund transaction:
              Tx ID: ${txHash}
              View on https://${network === 'preprod' ? 'preprod.' : ''}cardanoscan.io/transaction/${txHash}
              Smart Contract Address: ${smartContractAddress}
          `);
						return true;
					}),
				});

				let index = 0;
				for (const result of results) {
					const request = purchaseRequests[index];
					if (result.success == false || result.result != true) {
						const error = result.error;
						logger.error(`Error cancelling V1 refund ${request.id}`, { error });
						await prisma.purchaseRequest.update({
							where: { id: request.id },
							data: {
								...connectPreviousAction(request.nextActionId),
								...createNextPurchaseAction(PurchasingAction.WaitingForManualAction, {
									errorType: PurchaseErrorType.Unknown,
									errorNote: 'Cancelling refund failed: ' + interpretBlockchainError(error),
								}),
								SmartContractWallet: { update: { lockedAt: null } },
							},
						});
					}
					index++;
				}
			}),
		);
	} catch (error) {
		logger.error('Error cancelling V1 refunds', { error });
	} finally {
		release();
	}
}
