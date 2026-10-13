// Mesh SDK pinning: V2 package, V2 mesh line. See docs/adr/0005-meshsdk-version-pinning-v1-v2.md.
//
// The owner's `UpdatePolicy`: new per-asset limits, and value moved in from the
// owner, in one owner-signed transaction. The validator checks only the owner's
// signature and the continuing output (spend.ak `update_is_valid`), so every rule
// that keeps the wallet usable afterwards is checked here, before anything is built.
import {
	BlockfrostProvider,
	MeshTxBuilder,
	resolvePaymentKeyHash,
	resolveTxHash,
	type Asset,
	type UTxO,
} from '@meshsdk/core';
import { withMeshCostModelLock } from '@/utils/mesh-cost-model-sync';
import {
	deriveTotalCollateral,
	getSpendableWalletUtxos,
	lovelaceFromUtxo,
	nativeAssetCount,
	pickBatchCollateral,
} from '../builders/batch-helpers';
import { assetUnitOf } from './governed-asset';
import type { GuardedWalletParams } from './guarded-wallet';
import {
	buildWithEvaluatedBudgets,
	coinsPerUtxoSizeOf,
	guardedContinuingMinLovelace,
	loadV2ProtocolParameters,
} from './guarded-lock-builder';
import {
	assetValueData,
	assetValueEntries,
	assetValueGet,
	lovelaceOf,
	mapAssetValue,
	MAX_WALLET_ASSETS,
	SmartWalletAction,
	walletDatumData,
	type WalletDatum,
} from './wallet';
import { fetchWalletUtxo, loadSmartWalletScript, readWalletDatum, type SmartWalletScript } from './wallet-lifecycle';

/** A request the wallet must not take: the message is safe to show the operator. */
export class PolicyUpdateRefusedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PolicyUpdateRefusedError';
	}
}

const normalizeUnit = (unit: string) => (unit === '' ? 'lovelace' : unit);

function sumByUnit(assets: Asset[]): Map<string, bigint> {
	const sums = new Map<string, bigint>();
	for (const { unit, quantity } of assets) {
		const key = normalizeUnit(unit);
		sums.set(key, (sums.get(key) ?? 0n) + BigInt(quantity));
	}
	return sums;
}

export type PolicyUpdatePlan = {
	nextDatum: WalletDatum;
	/** Wallet value plus the deposit, before any min-UTxO top-up. */
	continuingAmount: Asset[];
};

/**
 * The next datum and wallet value, or a refusal. `limits` replaces the whole
 * limit; each counter that stays listed keeps its value, a new one starts at 0.
 * The asset order is canonical (sorted), so `limit` and `spent_in_period`
 * always list the same assets in the same order.
 */
export function planPolicyUpdate(params: {
	datum: WalletDatum;
	walletAmount: Asset[];
	stateTokenPolicyId: string;
	limits: Asset[];
	deposit: Asset[];
	/** The wallet's payment asset, in Exchain form. It must stay listed. */
	governedAsset: string;
	/** Exchain's mandate cannot change, so the governed limit must not either. */
	isRegisteredWithExchain: boolean;
}): PolicyUpdatePlan {
	const { datum, stateTokenPolicyId } = params;
	const limitUnits = params.limits.map((asset) => normalizeUnit(asset.unit));
	if (new Set(limitUnits).size !== limitUnits.length) {
		throw new PolicyUpdateRefusedError('limits lists an asset twice');
	}
	if (limitUnits.length > MAX_WALLET_ASSETS) {
		throw new PolicyUpdateRefusedError(`limits lists more than ${MAX_WALLET_ASSETS} assets`);
	}
	if (!limitUnits.includes('lovelace')) {
		throw new PolicyUpdateRefusedError('limits must list lovelace, or the wallet can neither spend nor receive ADA');
	}
	const governedUnit = assetUnitOf(params.governedAsset);
	if (!limitUnits.includes(governedUnit)) {
		throw new PolicyUpdateRefusedError(`limits must list the asset agents pay in (${params.governedAsset})`);
	}
	if (limitUnits.some((unit) => unit.startsWith(stateTokenPolicyId))) {
		// A listed state token would count as movable and could leave the wallet.
		throw new PolicyUpdateRefusedError('limits must not list the wallet state token');
	}
	const held = [...sumByUnit(params.walletAmount)].filter(
		([unit, quantity]) => quantity > 0n && !unit.startsWith(stateTokenPolicyId),
	);
	const dropped = held.find(([unit]) => !limitUnits.includes(unit));
	if (dropped != null) {
		throw new PolicyUpdateRefusedError(`the wallet holds ${dropped[0]}, so limits must keep listing it`);
	}
	for (const { unit, quantity } of params.deposit) {
		if (BigInt(quantity) <= 0n) throw new PolicyUpdateRefusedError('every deposit amount must be positive');
		if (!limitUnits.includes(normalizeUnit(unit))) {
			throw new PolicyUpdateRefusedError(`${unit} is not in limits, so a deposit of it would be frozen`);
		}
	}

	const limit = assetValueData(params.limits);
	const nextDatum: WalletDatum = {
		...datum,
		limit,
		spentInPeriod: mapAssetValue(
			limit,
			(policyId, assetName) => assetValueGet(datum.spentInPeriod, policyId, assetName) ?? 0n,
		),
	};
	if (params.isRegisteredWithExchain) {
		const before = limitOf(datum, governedUnit);
		const after = limitOf(nextDatum, governedUnit);
		if (before !== after) {
			throw new PolicyUpdateRefusedError(
				`the Exchain mandate is fixed at ${before ?? 'none'} for ${params.governedAsset}; register a new wallet to change it`,
			);
		}
	}
	const continuing = sumByUnit([...params.walletAmount, ...params.deposit]);
	return {
		nextDatum,
		continuingAmount: [...continuing].map(([unit, quantity]) => ({ unit, quantity: quantity.toString() })),
	};
}

function limitOf(datum: WalletDatum, unit: string): bigint | null {
	const entry = assetValueEntries(datum.limit).find(
		({ policyId, assetName }) => normalizeUnit(`${policyId}${assetName}`) === unit,
	);
	return entry?.quantity ?? null;
}

/** Add lovelace until the continuing output meets its own min-UTxO, which the new datum and tokens raise. */
export function withMinLovelace(amount: Asset[], minLovelace: bigint): Asset[] {
	const lovelace = lovelaceOf(amount);
	if (lovelace >= minLovelace) return amount;
	return [
		...amount.filter((asset) => normalizeUnit(asset.unit) !== 'lovelace'),
		{ unit: 'lovelace', quantity: minLovelace.toString() },
	];
}

/**
 * The owner's unsigned `UpdatePolicy`. The owner address pays the deposit, the
 * fee and any min-UTxO top-up, and lends the collateral; the owner key is the
 * only required signer, so one CIP-30 signature completes it.
 */
export async function buildOwnerPolicyUpdateTx(params: {
	provider: BlockfrostProvider;
	rpcApiKey: string;
	network: 'preprod' | 'mainnet';
	script: Pick<SmartWalletScript, 'address' | 'scriptCode' | 'owner'>;
	walletUtxo: UTxO;
	plan: PolicyUpdatePlan;
	ownerAddress: string;
	ownerUtxos: UTxO[];
}): Promise<{ unsignedTx: string; txHash: string; continuingAmount: Asset[] }> {
	const { provider, script, walletUtxo, plan, ownerAddress, ownerUtxos } = params;
	if (resolvePaymentKeyHash(ownerAddress) !== script.owner) {
		throw new PolicyUpdateRefusedError('the owner address does not carry the owner key of this wallet');
	}
	const protocolParameters = await loadV2ProtocolParameters(provider, params.rpcApiKey);
	const continuingAmount = withMinLovelace(
		plan.continuingAmount,
		guardedContinuingMinLovelace({
			address: script.address,
			datum: plan.nextDatum,
			amount: plan.continuingAmount,
			coinsPerUtxoSize: coinsPerUtxoSizeOf(protocolParameters),
		}),
	);
	const collateral = pickBatchCollateral(ownerUtxos, [walletUtxo.input]);
	if (collateral == null) {
		throw new PolicyUpdateRefusedError('the owner address holds no UTxO of at least 5 ADA to lend as collateral');
	}

	const { tx } = await buildWithEvaluatedBudgets(provider, ['SPEND'], async (budgets) => {
		const spend = budgets.get('SPEND');
		if (spend == null) throw new Error('missing SPEND budget');
		return await new MeshTxBuilder({ fetcher: provider })
			.protocolParams(protocolParameters)
			.spendingPlutusScript('V3')
			.txIn(
				walletUtxo.input.txHash,
				walletUtxo.input.outputIndex,
				walletUtxo.output.amount,
				walletUtxo.output.address,
				0,
			)
			.txInScript(script.scriptCode)
			.txInRedeemerValue({ alternative: SmartWalletAction.UpdatePolicy, fields: [] }, 'Mesh', spend)
			.txInInlineDatumPresent()
			// Continuing output first, like every other wallet spend.
			.txOut(script.address, continuingAmount)
			.txOutInlineDatumValue(walletDatumData(plan.nextDatum))
			.txInCollateral(
				collateral.input.txHash,
				collateral.input.outputIndex,
				collateral.output.amount,
				collateral.output.address,
			)
			.setTotalCollateral(
				deriveTotalCollateral([spend], protocolParameters, lovelaceFromUtxo(collateral), nativeAssetCount(collateral)),
			)
			.selectUtxosFrom(getSpendableWalletUtxos(ownerUtxos, collateral))
			.requiredSignerHash(script.owner)
			.changeAddress(ownerAddress)
			.setNetwork(params.network)
			.complete();
	});
	return { unsignedTx: tx, txHash: resolveTxHash(tx), continuingAmount };
}

/**
 * Read the wallet and the owner's UTxOs on L1 and build the owner's
 * `UpdatePolicy`. Lives here so the chain reads and the build stay on the V2
 * mesh line. Throws `GuardedWalletNotOnL1Error` when the wallet is in a head
 * and `PolicyUpdateRefusedError` for a request the wallet must not take.
 */
export async function prepareOwnerPolicyUpdate(params: {
	wallet: GuardedWalletParams;
	rpcApiKey: string;
	limits: Asset[];
	deposit: Asset[];
	governedAsset: string;
	isRegisteredWithExchain: boolean;
}): Promise<{ unsignedTx: string; txHash: string; walletUtxoRef: string; script: SmartWalletScript }> {
	const script = loadSmartWalletScript(params.wallet);
	const provider = new BlockfrostProvider(params.rpcApiKey);
	const walletUtxo = await fetchWalletUtxo(provider, script, params.wallet.stateTokenName);
	const plan = planPolicyUpdate({
		datum: readWalletDatum(walletUtxo),
		walletAmount: walletUtxo.output.amount,
		stateTokenPolicyId: script.policyId,
		limits: params.limits,
		deposit: params.deposit,
		governedAsset: params.governedAsset,
		isRegisteredWithExchain: params.isRegisteredWithExchain,
	});
	const ownerUtxos = await provider.fetchAddressUTxOs(params.wallet.ownerAddress);
	// The builder syncs mesh's process-global cost models, like every V2 Plutus build.
	const built = await withMeshCostModelLock(params.rpcApiKey, () =>
		buildOwnerPolicyUpdateTx({
			provider,
			rpcApiKey: params.rpcApiKey,
			network: params.wallet.network,
			script,
			walletUtxo,
			plan,
			ownerAddress: params.wallet.ownerAddress,
			ownerUtxos,
		}),
	);
	return {
		unsignedTx: built.unsignedTx,
		txHash: built.txHash,
		walletUtxoRef: `${walletUtxo.input.txHash}#${walletUtxo.input.outputIndex}`,
		script,
	};
}
