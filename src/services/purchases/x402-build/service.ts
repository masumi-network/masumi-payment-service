import {
	BlockfrostProvider,
	MeshTxBuilder,
	resolvePaymentKeyHash,
	SLOT_CONFIG_NETWORK,
	UTxO,
	unixTimeToEnclosingSlot,
} from '@meshsdk/core';
import { Address, Datum, toPlutusData, toValue, TransactionOutput } from '@meshsdk/core-cst';
import createHttpError from 'http-errors';
import { Network, PurchasingAction } from '@/generated/prisma/client';
import { prisma } from '@/utils/db';
import { getDatumFromBlockchainIdentifier, SmartContractState } from '@/utils/generator/contract-generator';
import { convertNetwork } from '@/utils/converter/network-convert';
import { calculateMinUtxo, DUMMY_RESULT_HASH, getNativeTokenCount } from '@/utils/min-utxo';
import { CONSTANTS } from '@/utils/config';
import { connectPreviousAction, createNextPurchaseAction } from '@/services/shared';
import { logger } from '@/utils/logger';

interface X402PurchaseBuildData {
	blockchainIdentifier: string;
	inputHash: string;
	payByTime: bigint;
	submitResultTime: bigint;
	unlockTime: bigint;
	externalDisputeUnlockTime: bigint;
	sellerAddress: string;
	paidFunds: Array<{ unit: string; amount: bigint }>;
	nextActionId?: string;
}

export async function buildX402FundsLockingTransaction({
	purchaseRequestId,
	purchaseRequestData,
	buyerAddress,
	blockchainProvider,
	network,
	scriptAddress,
	coinsPerUtxoSize,
	persistState = true,
}: {
	purchaseRequestId?: string;
	purchaseRequestData?: X402PurchaseBuildData;
	buyerAddress: string;
	blockchainProvider: BlockfrostProvider;
	network: Network;
	scriptAddress: string;
	coinsPerUtxoSize: number;
	persistState?: boolean;
}): Promise<{ unsignedTxCbor: string; collateralReturnLovelace: bigint; buyerWalletVkey: string }> {
	const persistedPurchaseRequest =
		purchaseRequestData == null
			? await prisma.purchaseRequest.findUnique({
					where: { id: purchaseRequestId },
					include: { PaidFunds: true, SellerWallet: true, NextAction: true },
				})
			: null;
	if (purchaseRequestData == null && persistedPurchaseRequest == null) {
		throw createHttpError(404, 'Purchase request not found');
	}

	const buildData: X402PurchaseBuildData =
		purchaseRequestData ??
		(() => {
			if (persistedPurchaseRequest == null) {
				throw createHttpError(500, 'Purchase request data is missing');
			}
			if (persistedPurchaseRequest.payByTime == null) {
				throw createHttpError(400, 'payByTime is required');
			}

			return {
				blockchainIdentifier: persistedPurchaseRequest.blockchainIdentifier,
				inputHash: persistedPurchaseRequest.inputHash,
				payByTime: persistedPurchaseRequest.payByTime,
				submitResultTime: persistedPurchaseRequest.submitResultTime,
				unlockTime: persistedPurchaseRequest.unlockTime,
				externalDisputeUnlockTime: persistedPurchaseRequest.externalDisputeUnlockTime,
				sellerAddress: persistedPurchaseRequest.SellerWallet.walletAddress,
				paidFunds: persistedPurchaseRequest.PaidFunds.map((fund) => ({
					unit: fund.unit,
					amount: fund.amount,
				})),
				nextActionId: persistedPurchaseRequest.nextActionId,
			};
		})();

	// Step 1: Estimate min UTXO via dummy datum (same algorithm as batch-payments service)
	const tmpDatum = getDatumFromBlockchainIdentifier({
		buyerAddress,
		sellerAddress: buildData.sellerAddress,
		blockchainIdentifier: buildData.blockchainIdentifier,
		inputHash: buildData.inputHash,
		resultHash: DUMMY_RESULT_HASH,
		payByTime: BigInt(Date.now()),
		collateralReturnLovelace: 1_000_000_000n,
		resultTime: buildData.submitResultTime,
		unlockTime: buildData.unlockTime,
		externalDisputeUnlockTime: buildData.externalDisputeUnlockTime,
		newCooldownTimeSeller: 0n,
		newCooldownTimeBuyer: BigInt(Date.now()),
		state: SmartContractState.FundsLocked,
	});

	const nativeTokenCount = getNativeTokenCount(
		buildData.paidFunds.map((fund) => ({
			unit: fund.unit,
			quantity: fund.amount.toString(),
		})),
	);

	const lovelaceAmountRaw =
		buildData.paidFunds.find((fund) => fund.unit === '' || fund.unit.toLowerCase() === 'lovelace')?.amount ?? 0n;

	const { minUtxoLovelace: firstEstimate } = calculateMinUtxo({
		datum: tmpDatum.value,
		nativeTokenCount,
		coinsPerUtxoSize,
		includeBuffers: true,
	});

	// Use cbor-based dummyOutput approach for accurate estimate (identical to batch-payments lines 452-478)
	const dummyOutput = new TransactionOutput(
		Address.fromBech32(scriptAddress),
		toValue([
			...buildData.paidFunds
				.filter((f) => f.unit !== '' && f.unit.toLowerCase() !== 'lovelace')
				.map((f) => ({ unit: f.unit, quantity: f.amount.toString() })),
			{
				unit: 'lovelace',
				quantity: (lovelaceAmountRaw > firstEstimate ? lovelaceAmountRaw : firstEstimate).toString(),
			},
		]),
	);
	dummyOutput.setDatum(Datum.newInlineData(toPlutusData(tmpDatum.value)));
	const dummyCbor: unknown = dummyOutput.toCbor();
	if (typeof dummyCbor !== 'string') {
		throw new TypeError('Expected dummyOutput.toCbor() to return a string, got: ' + typeof dummyCbor);
	}

	const DEFAULT_OVERHEAD_SIZE = 160;
	const BUFFER_SIZE_COOLDOWN_TIME = 15;
	const overestimatedMinUtxoCost =
		BigInt(DEFAULT_OVERHEAD_SIZE + BUFFER_SIZE_COOLDOWN_TIME + Math.ceil(dummyCbor.length / 2)) *
		BigInt(coinsPerUtxoSize);

	// Step 2: Calculate collateralReturnLovelace and adjust lovelace in payment amounts
	const adjustedFunds = buildData.paidFunds.map((fund) => ({ ...fund }));
	let collateralReturnLovelace = 0n;
	const lovelaceIndex = adjustedFunds.findIndex((f) => f.unit === '' || f.unit.toLowerCase() === 'lovelace');

	if (lovelaceIndex === -1) {
		// No lovelace in payment — add min UTXO cost as collateral
		collateralReturnLovelace = overestimatedMinUtxoCost;
		adjustedFunds.push({ unit: '', amount: overestimatedMinUtxoCost });
	} else if (adjustedFunds[lovelaceIndex].amount < overestimatedMinUtxoCost) {
		const rawDiff = overestimatedMinUtxoCost - adjustedFunds[lovelaceIndex].amount;
		collateralReturnLovelace =
			rawDiff > 0n && rawDiff < CONSTANTS.MIN_COLLATERAL_LOVELACE ? CONSTANTS.MIN_COLLATERAL_LOVELACE : rawDiff;
		adjustedFunds[lovelaceIndex] = {
			...adjustedFunds[lovelaceIndex],
			amount: adjustedFunds[lovelaceIndex].amount + collateralReturnLovelace,
		};
	}

	// Step 3: Build final datum with real values
	const finalDatum = getDatumFromBlockchainIdentifier({
		buyerAddress,
		sellerAddress: buildData.sellerAddress,
		blockchainIdentifier: buildData.blockchainIdentifier,
		inputHash: buildData.inputHash,
		resultHash: null,
		payByTime: buildData.payByTime,
		collateralReturnLovelace,
		resultTime: buildData.submitResultTime,
		unlockTime: buildData.unlockTime,
		externalDisputeUnlockTime: buildData.externalDisputeUnlockTime,
		newCooldownTimeSeller: 0n,
		newCooldownTimeBuyer: 0n,
		state: SmartContractState.FundsLocked,
	});

	// Step 4: Fetch buyer UTxOs and select the minimum needed
	const buyerUtxos: UTxO[] = await blockchainProvider.fetchAddressUTxOs(buyerAddress);
	if (buyerUtxos.length === 0) throw createHttpError(400, 'Buyer address has no UTXOs');

	const totalLovelaceNeeded =
		(adjustedFunds.find((f) => f.unit === '' || f.unit.toLowerCase() === 'lovelace')?.amount ?? 0n) +
		CONSTANTS.MIN_TX_FEE_BUFFER_LOVELACE;

	const selectedUtxos = selectUtxosForPayment(buyerUtxos, adjustedFunds, totalLovelaceNeeded);

	// Step 5: Build unsigned transaction with MeshTxBuilder
	const meshNetwork = convertNetwork(network);
	const invalidBefore = unixTimeToEnclosingSlot(Date.now() - 300_000, SLOT_CONFIG_NETWORK[meshNetwork]) - 1;
	// Use payByTime as the tx validity upper bound so the buyer has the full window to sign and submit
	const invalidAfterMs = Number(buildData.payByTime);
	const invalidAfter = unixTimeToEnclosingSlot(invalidAfterMs, SLOT_CONFIG_NETWORK[meshNetwork]) + 5;

	const txBuilder = new MeshTxBuilder({ fetcher: blockchainProvider });
	const deserializedBuyerAddress = txBuilder.serializer.deserializer.key.deserializeAddress(buyerAddress);
	for (const utxo of selectedUtxos) {
		txBuilder.txIn(utxo.input.txHash, utxo.input.outputIndex, utxo.output.amount, utxo.output.address);
	}

	const paymentAssets = adjustedFunds.map((f) => ({
		unit: f.unit === '' ? 'lovelace' : f.unit,
		quantity: f.amount.toString(),
	}));

	const unsignedTxCbor = await txBuilder
		.txOut(scriptAddress, paymentAssets)
		.txOutInlineDatumValue(finalDatum.value)
		.changeAddress(buyerAddress)
		.invalidBefore(invalidBefore)
		.invalidHereafter(invalidAfter)
		.requiredSignerHash(deserializedBuyerAddress.pubKeyHash)
		.setNetwork(meshNetwork)
		.metadataValue(674, { msg: ['Masumi', 'PaymentX402'] })
		.complete();

	// Step 6: Compute buyer vkey and transition purchase state
	const buyerWalletVkey = resolvePaymentKeyHash(buyerAddress);

	if (persistState) {
		if (purchaseRequestId == null || buildData.nextActionId == null) {
			throw createHttpError(500, 'Purchase request persistence requires purchaseRequestId and nextActionId');
		}
		await prisma.purchaseRequest.update({
			where: { id: purchaseRequestId },
			data: {
				...connectPreviousAction(buildData.nextActionId),
				...createNextPurchaseAction(PurchasingAction.ExternalFundsLockingInitiated),
				collateralReturnLovelace,
				buyerWalletAddress: buyerAddress,
				buyerWalletVkey,
			},
		});
	}

	logger.info('Built x402 unsigned funds-locking transaction', {
		purchaseRequestId,
		buyerAddress,
		collateralReturnLovelace: collateralReturnLovelace.toString(),
	});

	return { unsignedTxCbor, collateralReturnLovelace, buyerWalletVkey };
}

/**
 * Greedy coin selection: select the minimum set of UTxOs that cover all required funds.
 * Sorted by lovelace descending for efficiency.
 */
function selectUtxosForPayment(
	utxos: UTxO[],
	requiredFunds: Array<{ unit: string; amount: bigint }>,
	totalLovelaceNeeded: bigint,
): UTxO[] {
	const remaining = new Map<string, bigint>();
	for (const f of requiredFunds) {
		const unit = f.unit === '' ? 'lovelace' : f.unit;
		remaining.set(unit, (remaining.get(unit) ?? 0n) + f.amount);
	}
	// Override lovelace requirement with fee-inclusive amount
	remaining.set('lovelace', totalLovelaceNeeded);

	const sorted = [...utxos].sort((a, b) => {
		const aL = BigInt(a.output.amount.find((x) => x.unit === 'lovelace')?.quantity ?? '0');
		const bL = BigInt(b.output.amount.find((x) => x.unit === 'lovelace')?.quantity ?? '0');
		return bL > aL ? 1 : bL < aL ? -1 : 0;
	});

	const selected: UTxO[] = [];
	for (const utxo of sorted) {
		if (remaining.size === 0) break;
		let useful = false;
		for (const asset of utxo.output.amount) {
			const unit = asset.unit === '' ? 'lovelace' : asset.unit;
			if (remaining.has(unit)) {
				const need = remaining.get(unit)!;
				const have = BigInt(asset.quantity);
				if (have >= need) {
					remaining.delete(unit);
				} else {
					remaining.set(unit, need - have);
				}
				useful = true;
			}
		}
		if (useful) selected.push(utxo);
	}

	if (remaining.size > 0) {
		const missing = [...remaining.entries()].map(([u, a]) => `${a} ${u}`).join(', ');
		throw createHttpError(400, `Buyer has insufficient funds. Missing: ${missing}`);
	}

	return selected;
}
