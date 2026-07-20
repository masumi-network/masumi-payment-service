import { OnChainState, PaymentAction, PaymentSourceType, TransactionStatus, Prisma } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { Asset, BlockfrostProvider, deserializeDatum } from '@meshsdk/core';
import { logger } from '@masumi/payment-core/logger';
import { smartContractStateEqualsOnChainState } from '@masumi/payment-core/smart-contract-state';
import { convertNetwork } from '@masumi/payment-core/network';
// TODO(v1-package-boundary): move lock-and-query-payments, blockchain-error-interpreter, utxo, transaction-generator, string-datum-convert to @masumi/payment-core
import { lockAndQueryPayments } from '@/utils/db/lock-and-query-payments';
import { interpretBlockchainError } from '@masumi/payment-core/blockchain-error-interpreter';
import { advancedRetryAll, delayErrorResolver } from 'advanced-retry';
import { selectCollateralUtxo } from '@/utils/utxo';
import { writePaymentErrorTransition } from '@/services/shared/error-transition';
import { Mutex, MutexInterface, tryAcquire } from 'async-mutex';
import { generateMasumiSmartContractWithdrawTransactionAutomaticFees } from '@/utils/generator/transaction-generator';
import { CONSTANTS } from '@masumi/payment-core/config';
import {
	connectPreviousAction,
	createMeshProvider,
	createNextPaymentAction,
	createTxWindow,
	loadHotWalletSession,
	updateCurrentTransactionHash,
} from '@/services/shared';
import { getPaymentScriptFromPaymentSourceV1 } from '@masumi/payment-source-v1';
import { decodeV1ContractDatum } from '@/utils/converter/string-datum-convert';

type PaymentSourceWithRelations = Prisma.PaymentSourceGetPayload<{
	include: {
		PaymentRequests: {
			include: {
				NextAction: true;
				CurrentTransaction: true;
				RequestedFunds: true;
				BuyerWallet: true;
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

type PaymentRequestWithRelations = PaymentSourceWithRelations['PaymentRequests'][number];

const mutex = new Mutex();

async function processSinglePaymentCollection(
	request: PaymentRequestWithRelations,
	paymentContract: PaymentSourceWithRelations,
	blockchainProvider: BlockfrostProvider,
	network: 'mainnet' | 'preprod',
): Promise<boolean> {
	if (request.payByTime == null) {
		throw new Error('Pay by time is null, this is deprecated');
	}
	if (request.collateralReturnLovelace == null) {
		throw new Error('Collateral return lovelace is null, this is deprecated');
	}
	if (request.SmartContractWallet == null) throw new Error('Smart contract wallet not found');

	const walletSession = await loadHotWalletSession({
		network: paymentContract.network,
		rpcProviderApiKey: paymentContract.PaymentSourceConfig.rpcProviderApiKey,
		encryptedMnemonic: request.SmartContractWallet.Secret.encryptedMnemonic,
		hotWalletId: request.SmartContractWallet.id,
	});
	const { wallet, utxos, address } = walletSession;

	if (utxos.length === 0) {
		//this is if the seller wallet is empty
		throw new Error('No UTXOs found in the wallet. Wallet is empty.');
	}

	const { script, smartContractAddress } = await getPaymentScriptFromPaymentSourceV1(paymentContract);

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
		const decodedContract = decodeV1ContractDatum(decodedDatum, network);
		if (decodedContract == null) {
			return false;
		}

		return (
			smartContractStateEqualsOnChainState(decodedContract.state, request.onChainState) &&
			decodedContract.buyerAddress == request.BuyerWallet!.walletAddress &&
			decodedContract.sellerAddress == request.SmartContractWallet!.walletAddress &&
			decodedContract.buyerVkey == request.BuyerWallet!.walletVkey &&
			decodedContract.sellerVkey == request.SmartContractWallet!.walletVkey &&
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
	const decodedContract = decodeV1ContractDatum(decodedDatum, network);
	if (decodedContract == null) {
		throw new Error('Invalid datum');
	}

	if (BigInt(decodedContract.collateralReturnLovelace) != request.collateralReturnLovelace) {
		logger.error(
			'Collateral return lovelace does not match collateral return lovelace in db. This likely is a spoofing attempt.',
			{
				purchaseRequest: request,
				collateralReturnLovelace: decodedContract.collateralReturnLovelace,
			},
		);
		throw new Error(
			'Collateral return lovelace does not match collateral return lovelace in db. This likely is a spoofing attempt.',
		);
	}

	const { invalidBefore, invalidAfter } = createTxWindow(network, {
		constrainBeforeMs: Number(decodedContract.sellerCooldownTime),
	});

	const buyerAddress = request.BuyerWallet?.walletAddress;
	if (buyerAddress == null) {
		throw new Error('Buyer wallet not found');
	}
	if (buyerAddress != decodedContract.buyerAddress) {
		throw new Error('Buyer wallet does not match buyer in contract');
	}

	const collateralReturnLovelace = request.collateralReturnLovelace;
	if (collateralReturnLovelace == null) {
		throw new Error('Collateral return lovelace not found');
	}
	if (BigInt(decodedContract.collateralReturnLovelace) != collateralReturnLovelace) {
		throw new Error('Collateral return lovelace does not match collateral return lovelace in db.');
	}

	const remainingAssets: { [key: string]: Asset } = {};
	const feeAssets: { [key: string]: Asset } = {};
	for (const assetValue of utxo.output.amount) {
		const assetKey = assetValue.unit;
		const value = BigInt(assetValue.quantity);
		const isLovelace = assetValue.unit == '' || assetValue.unit.toLowerCase() == 'lovelace';
		// Fee math must stay in BigInt. The old `BigInt(Math.max(minFee, Number(value) * permille / 1000))`
		// threw RangeError on any non-integer result (e.g. native tokens, or lovelace fees above the
		// collateral floor) and lost precision above 2^53 — crashing every collection retry and stranding
		// the seller's withdrawal in WaitingForManualAction.
		const minFee =
			paymentContract.paymentSourceType !== PaymentSourceType.Web3CardanoV2 && isLovelace
				? CONSTANTS.MIN_COLLATERAL_LOVELACE
				: 0n;
		const proportionalFee = (value * BigInt(paymentContract.feeRatePermille)) / 1000n;
		const feeValue =
			paymentContract.paymentSourceType === PaymentSourceType.Web3CardanoV2
				? 0n
				: proportionalFee > minFee
					? proportionalFee
					: minFee;
		const remainingValue = value - feeValue;
		const remainingValueAsset: Asset = {
			unit: assetValue.unit,
			quantity: remainingValue.toString(),
		};
		if (BigInt(remainingValueAsset.quantity) > 0) {
			remainingAssets[assetKey] = remainingValueAsset;
		} else {
			delete remainingAssets[assetKey];
		}
		const feeValueAsset: Asset = {
			unit: assetValue.unit,
			quantity: feeValue.toString(),
		};
		if (BigInt(feeValueAsset.quantity) > 0) {
			feeAssets[assetKey] = feeValueAsset;
		} else {
			delete feeAssets[assetKey];
		}
	}

	// sellerReturnAddress validated at route via src/routes/api/payments/schemas.ts (isCardanoAddressForNetwork superRefine)
	let collectionAddress = request.sellerReturnAddress ?? request.SmartContractWallet.collectionAddress;
	if (collectionAddress == null || collectionAddress == '') {
		collectionAddress = request.SmartContractWallet.walletAddress;
	}

	const collateralUtxo = selectCollateralUtxo(utxos);
	const feeReceiverAddress = paymentContract.FeeReceiverNetworkWallet?.walletAddress ?? collectionAddress;
	const shouldIncludeFeeOutput =
		paymentContract.paymentSourceType !== PaymentSourceType.Web3CardanoV2 && Object.values(feeAssets).length > 0;

	const unsignedTx = await generateMasumiSmartContractWithdrawTransactionAutomaticFees(
		'CollectCompleted',
		blockchainProvider,
		network,
		script,
		address,
		utxo,
		collateralUtxo,
		utxos,
		{
			collectAssets: Object.values(remainingAssets),
			collectionAddress: collectionAddress,
		},
		shouldIncludeFeeOutput
			? {
					feeAssets: Object.values(feeAssets),
					feeAddress: feeReceiverAddress,
					txHash: utxo.input.txHash,
					outputIndex: utxo.input.outputIndex,
				}
			: null,
		{
			lovelace: collateralReturnLovelace,
			address: buyerAddress,
			txHash: utxo.input.txHash,
			outputIndex: utxo.input.outputIndex,
		},
		invalidBefore,
		invalidAfter,
		false,
		paymentContract.PaymentSourceConfig.rpcProviderApiKey,
	);

	const signedTx = await wallet.signTx(unsignedTx);
	await prisma.paymentRequest.update({
		where: { id: request.id },
		data: {
			...connectPreviousAction(request.nextActionId),
			...createNextPaymentAction(PaymentAction.WithdrawInitiated),
			CurrentTransaction: {
				update: {
					txHash: null,
					status: TransactionStatus.Pending,
					BlocksWallet: {
						connect: {
							id: request.SmartContractWallet.id,
						},
					},
				},
			},
			TransactionHistory: {
				connect: {
					id: request.CurrentTransaction!.id,
				},
			},
		},
	});
	//submit the transaction to the blockchain
	const newTxHash = await wallet.submitTx(signedTx);
	await walletSession.evaluateProjectedBalance(unsignedTx, utxos);

	await prisma.paymentRequest.update({
		where: { id: request.id },
		data: updateCurrentTransactionHash(newTxHash),
	});
	logger.debug(`Created withdrawal transaction:
        Tx ID: ${newTxHash}
        View (after a bit) on https://${network === 'preprod' ? 'preprod.' : ''}cardanoscan.io/transaction/${newTxHash}
        Smart Contract Address: ${smartContractAddress}
    `);
	return true;
}

export async function collectOutstandingPaymentsV1() {
	//const maxBatchSize = 10;

	let release: MutexInterface.Releaser | null;
	try {
		release = await tryAcquire(mutex).acquire();
	} catch {
		logger.info('payment_collection_v1 is already running, skipping cycle');
		return;
	}

	try {
		const paymentContractsWithWalletLocked = await lockAndQueryPayments({
			paymentStatus: PaymentAction.WithdrawRequested,
			resultHash: { not: null },
			unlockTime: { lte: Date.now() - 1000 * 60 * 10 },
			onChainState: { in: [OnChainState.ResultSubmitted] },
			maxBatchSize: 1,
			paymentSourceType: PaymentSourceType.Web3CardanoV1,
		});

		await Promise.allSettled(
			paymentContractsWithWalletLocked.map(async (paymentContract) => {
				if (paymentContract.PaymentRequests.length == 0) return;

				logger.info(
					`Collecting ${paymentContract.PaymentRequests.length} payments for payment source ${paymentContract.id}`,
				);

				const network = convertNetwork(paymentContract.network);

				const blockchainProvider = await createMeshProvider(paymentContract.PaymentSourceConfig.rpcProviderApiKey);

				const paymentRequests = paymentContract.PaymentRequests;

				if (paymentRequests.length == 0) return;

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
					operations: paymentRequests.map(
						(request) => async () =>
							processSinglePaymentCollection(request, paymentContract, blockchainProvider, network),
					),
				});
				let index = 0;
				for (const result of results) {
					const request = paymentRequests[index];
					if (result.success == false || result.result != true) {
						const error = result.error;
						logger.error(`Error collecting payments ${request.id}`, {
							error: error,
						});
						await prisma.$transaction((tx) =>
							writePaymentErrorTransition(tx, {
								requestId: request.id,
								nextActionId: request.nextActionId,
								errorNote: 'Collecting payments failed: ' + interpretBlockchainError(error),
							}),
						);
					}
					index++;
				}
			}),
		);
	} catch (error) {
		logger.error('Error collecting outstanding payments', { error: error });
	} finally {
		release?.();
	}
}
