// Mesh SDK pinning: V2 package, so `@meshsdk/core` is the V2 line. See
// docs/adr/0005-meshsdk-version-pinning-v1-v2.md.
//
// The in-head twin of `buildGuardedLockTx`: an AgentSpend of the guarded wallet
// inside a Hydra head, frozen before any co-signer sees it. The head charges no
// fee and has no evaluator, so the body carries fee 0, total collateral 0 and a
// fixed script budget, and its script integrity hash uses the head's cost models.
import {
	MeshTxBuilder,
	resolvePaymentKeyHash,
	resolveTxHash,
	SLOT_CONFIG_NETWORK,
	slotToBeginUnixTime,
	type Asset,
	type Protocol,
	type UTxO,
} from '@meshsdk/core';
import { withMeshCostModelLock } from '@/utils/mesh-cost-model-sync';
import { syncMeshCostModelsFromHeadV2, type HeadRawCostModels } from '../utils/mesh-cost-model-sync';
import {
	assertGuardedLockParams,
	GuardedContinuingOutputTooSmallError,
	guardedContinuingMinLovelace,
	readLockOutputIndexes,
	type GuardedLockOutput,
} from './guarded-lock-builder';
import { L2_WALLET_SPEND_EX_UNITS } from './hydra-transfer';
import {
	applyAgentSpend,
	assetsMinus,
	lovelaceOf,
	outflowOf,
	SmartWalletAction,
	walletDatumData,
	type WalletDatum,
} from './wallet';

export type BuildGuardedL2LockParams = {
	network: 'preprod' | 'mainnet';
	wallet: { scriptCode: string; address: string };
	/** The wallet UTxO as the head snapshot holds it. */
	walletUtxo: UTxO;
	walletDatum: WalletDatum;
	agentAddress: string;
	/** A plain in-head UTxO of the agent key. Never spent: the head charges no fee. */
	collateral: UTxO;
	cosignerVkhs: string[];
	locks: GuardedLockOutput[];
	/** Validity window in slots, from the head clock. */
	window: { invalidBefore: number; invalidAfter: number };
	protocolParameters: Protocol;
	headCostModels: HeadRawCostModels;
};

export type GuardedL2LockBuild = {
	unsignedTx: string;
	txHash: string;
	lockOutputIndexes: number[];
	nextDatum: WalletDatum;
	continuingAmount: Asset[];
};

export async function buildGuardedL2LockTx(params: BuildGuardedL2LockParams): Promise<GuardedL2LockBuild> {
	const { network, wallet, walletUtxo, collateral, locks, window } = params;
	const agentVkh = resolvePaymentKeyHash(params.agentAddress);
	assertGuardedLockParams(params, agentVkh);
	if (collateral.output.address !== params.agentAddress) {
		throw new Error('the in-head collateral must belong to the agent key');
	}

	const slotConfig = SLOT_CONFIG_NETWORK[network];
	const continuingAmount = assetsMinus(
		walletUtxo.output.amount,
		locks.flatMap((lock) => lock.amount),
	);
	const nextDatum = applyAgentSpend(params.walletDatum, {
		outflow: outflowOf(walletUtxo.output.amount, continuingAmount),
		continuingLovelace: lovelaceOf(continuingAmount),
		validity: {
			lowerMs: BigInt(slotToBeginUnixTime(window.invalidBefore, slotConfig)),
			upperMs: BigInt(slotToBeginUnixTime(window.invalidAfter, slotConfig)),
		},
	});
	const continuingMin = guardedContinuingMinLovelace({
		address: wallet.address,
		datum: nextDatum,
		amount: continuingAmount,
		coinsPerUtxoSize: params.protocolParameters.coinsPerUtxoSize,
	});
	if (lovelaceOf(continuingAmount) < continuingMin) {
		throw new GuardedContinuingOutputTooSmallError(lovelaceOf(continuingAmount), continuingMin);
	}
	const requiredSigners = [agentVkh, ...params.cosignerVkhs];

	const unsignedTx = await withMeshCostModelLock('hydra', async () => {
		await syncMeshCostModelsFromHeadV2(params.headCostModels);
		const txBuilder = new MeshTxBuilder({ isHydra: true });
		txBuilder.protocolParams(params.protocolParameters);
		txBuilder.setFee('0');
		txBuilder
			.spendingPlutusScript('V3')
			// scriptSize 0 keeps the input complete, so mesh never asks the head for a per-tx lookup.
			.txIn(
				walletUtxo.input.txHash,
				walletUtxo.input.outputIndex,
				walletUtxo.output.amount,
				walletUtxo.output.address,
				0,
			)
			.txInScript(wallet.scriptCode)
			.txInRedeemerValue({ alternative: SmartWalletAction.AgentSpend, fields: [] }, 'Mesh', L2_WALLET_SPEND_EX_UNITS)
			.txInInlineDatumPresent()
			// Continuing output first, as on L1: the co-signer finds the wallet and the locks by index.
			.txOut(wallet.address, continuingAmount)
			.txOutInlineDatumValue(walletDatumData(nextDatum));
		for (const lock of locks) {
			txBuilder.txOut(lock.address, lock.amount).txOutInlineDatumValue(lock.datum);
		}
		txBuilder
			.txInCollateral(
				collateral.input.txHash,
				collateral.input.outputIndex,
				collateral.output.amount,
				collateral.output.address,
			)
			.setTotalCollateral('0')
			// Mesh returns the whole collateral to the change address; nothing else is balanced.
			.changeAddress(params.agentAddress)
			.invalidBefore(window.invalidBefore)
			.invalidHereafter(window.invalidAfter)
			.setNetwork(network)
			.metadataValue(674, { msg: ['Masumi', 'PaymentBatched'] });
		for (const vkh of requiredSigners) txBuilder.requiredSignerHash(vkh);
		return txBuilder.completeUnbalanced();
	});

	return {
		unsignedTx,
		txHash: resolveTxHash(unsignedTx),
		lockOutputIndexes: readLockOutputIndexes(
			unsignedTx,
			wallet.address,
			locks.map((lock) => lock.address),
		),
		nextDatum,
		continuingAmount,
	};
}
