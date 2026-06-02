import { resolvePaymentKeyHash, SLOT_CONFIG_NETWORK, UTxO, unixTimeToEnclosingSlot } from '@meshsdk/core';
import { MeshTxBuilder } from '@/services/shared';
import type { BlockfrostProvider } from '@/services/shared';
import { Address, Datum, toPlutusData, toValue, TransactionOutput } from '@meshsdk/core-cst';
import createHttpError from 'http-errors';
import { Network } from '@/generated/prisma/client';
import { SmartContractState } from '@/utils/generator/contract-generator';
import { convertNetwork } from '@/utils/converter/network-convert';
import { calculateMinUtxo, DUMMY_RESULT_HASH, getNativeTokenCount } from '@/utils/min-utxo';
import { CONSTANTS } from '@masumi/payment-core/config';
import { logger } from '@masumi/payment-core/logger';
import { createDatumFromBlockchainIdentifierV2 } from '@masumi/payment-source-v2';

interface X402PurchaseBuildData {
	blockchainIdentifier: string;
	inputHash: string;
	payByTime: bigint;
	submitResultTime: bigint;
	unlockTime: bigint;
	externalDisputeUnlockTime: bigint;
	sellerAddress: string;
	sellerReturnAddress: string | null;
	buyerReturnAddress: string | null;
	paidFunds: Array<{ unit: string; amount: bigint }>;
}

export async function buildX402FundsLockingTransactionV2({
	purchaseRequestData,
	buyerAddress,
	blockchainProvider,
	network,
	scriptAddress,
	coinsPerUtxoSize,
}: {
	purchaseRequestData: X402PurchaseBuildData;
	buyerAddress: string;
	blockchainProvider: BlockfrostProvider;
	network: Network;
	scriptAddress: string;
	coinsPerUtxoSize: number;
}): Promise<{ unsignedTxCbor: string; collateralReturnLovelace: bigint; buyerWalletVkey: string }> {
	const buildData = purchaseRequestData;

	const tmpDatum = createDatumFromBlockchainIdentifierV2({
		buyerAddress,
		buyerReturnAddress: buildData.buyerReturnAddress,
		sellerAddress: buildData.sellerAddress,
		sellerReturnAddress: buildData.sellerReturnAddress,
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
		buildData.paidFunds.map((fund) => ({ unit: fund.unit, quantity: fund.amount.toString() })),
	);
	const lovelaceAmountRaw =
		buildData.paidFunds.find((fund) => fund.unit === '' || fund.unit.toLowerCase() === 'lovelace')?.amount ?? 0n;

	const { minUtxoLovelace: firstEstimate } = calculateMinUtxo({
		datum: tmpDatum.value,
		nativeTokenCount,
		coinsPerUtxoSize,
		includeBuffers: true,
	});

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

	const adjustedFunds = buildData.paidFunds.map((fund) => ({ ...fund }));
	let collateralReturnLovelace = 0n;
	const lovelaceIndex = adjustedFunds.findIndex((f) => f.unit === '' || f.unit.toLowerCase() === 'lovelace');

	if (lovelaceIndex === -1) {
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

	const finalDatum = createDatumFromBlockchainIdentifierV2({
		buyerAddress,
		buyerReturnAddress: buildData.buyerReturnAddress,
		sellerAddress: buildData.sellerAddress,
		sellerReturnAddress: buildData.sellerReturnAddress,
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

	const buyerUtxos: UTxO[] = await blockchainProvider.fetchAddressUTxOs(buyerAddress);
	if (buyerUtxos.length === 0) throw createHttpError(400, 'Buyer address has no UTXOs');

	const totalLovelaceNeeded =
		(adjustedFunds.find((f) => f.unit === '' || f.unit.toLowerCase() === 'lovelace')?.amount ?? 0n) +
		CONSTANTS.MIN_TX_FEE_BUFFER_LOVELACE;
	const selectedUtxos = selectUtxosForPayment(buyerUtxos, adjustedFunds, totalLovelaceNeeded);

	const meshNetwork = convertNetwork(network);
	const invalidBefore = unixTimeToEnclosingSlot(Date.now() - 300_000, SLOT_CONFIG_NETWORK[meshNetwork]) - 1;
	// `unixTimeToEnclosingSlot` accepts `number`, but `payByTime` is `bigint`
	// in our DB. ms-since-epoch fits inside `Number.MAX_SAFE_INTEGER` for any
	// realistic deadline (~285k years), so the BigInt→Number coerce is safe
	// — but guard explicitly so a malformed or attacker-supplied value
	// surfaces loudly instead of silently rounding to a slot we didn't intend.
	if (buildData.payByTime > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw createHttpError(400, 'payByTime exceeds safe integer range');
	}
	const invalidAfterMs = Number(buildData.payByTime);
	const invalidAfter = unixTimeToEnclosingSlot(invalidAfterMs, SLOT_CONFIG_NETWORK[meshNetwork]) + 30;

	// Pull live chain protocol params so script_data_hash matches the
	// ledger's computation. See generateRegistryMintTransaction in
	// src/services/registry/shared.ts for the full rationale.
	// NaN routes to /epochs/latest/parameters in the BlockfrostProvider impl.
	const protocolParameters = await blockchainProvider.fetchProtocolParameters(Number.NaN);
	const txBuilder = new MeshTxBuilder({ fetcher: blockchainProvider });
	txBuilder.protocolParams(protocolParameters);
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
		.metadataValue(674, { msg: ['Masumi', 'PaymentX402V2'] })
		.complete();

	const buyerWalletVkey = resolvePaymentKeyHash(buyerAddress);

	logger.info('Built V2 x402 unsigned funds-locking transaction', {
		buyerAddress,
		collateralReturnLovelace: collateralReturnLovelace.toString(),
	});

	return { unsignedTxCbor, collateralReturnLovelace, buyerWalletVkey };
}

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
