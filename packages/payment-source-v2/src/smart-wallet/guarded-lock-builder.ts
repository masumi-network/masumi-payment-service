// Mesh SDK pinning: this file lives in the V2 package and MUST resolve to the
// V2 mesh line (`@meshsdk/core@1.9.0-beta.103`). The script-data-hash and CBOR
// encoding depend on it. See docs/adr/0005-meshsdk-version-pinning-v1-v2.md.
//
// Builds a funds-lock transaction paid from the agent treasury smart wallet
// (`smart-contracts/smart-wallet`, PR 729) and FREEZES its body. The returned
// `unsignedTx` is final: required signers, collateral, exUnits and fee are all
// settled before any co-signer sees it, because a vkey witness signs the body
// hash and any rebuild afterwards would invalidate every collected signature.
import {
	MeshTxBuilder,
	resolvePaymentKeyHash,
	resolveTxHash,
	SLOT_CONFIG_NETWORK,
	slotToBeginUnixTime,
	type Asset,
	type BlockfrostProvider,
	type Data,
	type UTxO,
} from '@meshsdk/core';
import { deserializeTx } from '@meshsdk/core-cst';
import { isInsufficientBalanceBuildError } from '@masumi/payment-core/insufficient-balance-error';
import { createTxWindow } from '@/services/shared/tx-window';
import { getCachedChainProtocolParameters } from '@/utils/mesh-cost-model-sync';
import {
	deriveTotalCollateral,
	getSpendableWalletUtxos,
	isTxSizeWithinLimit,
	lovelaceFromUtxo,
	MAX_SAFE_TX_BYTES,
	nativeAssetCount,
	pickBatchCollateral,
} from '../builders/batch-helpers';
import { syncMeshCostModelsFromChainV2 } from '../utils/mesh-cost-model-sync';
import {
	applyAgentSpend,
	assetsMinus,
	lovelaceOf,
	outflowOf,
	SmartWalletAction,
	walletDatumData,
	type WalletDatum,
} from './wallet';

export type ExUnits = { mem: number; steps: number };
export type RedeemerTag = 'SPEND' | 'MINT';
type Budgets = Map<RedeemerTag, ExUnits>;

const DEFAULT_EX_UNITS: ExUnits = { mem: 7_000_000, steps: 3_000_000_000 };
// Same 10% over-declaration as builders/batch-interaction.ts: evaluateTx reports
// the exact budget of the default-budget draft, and the final body differs in
// its declared exUnits and fee, which the ScriptContext includes.
const EX_UNITS_SAFETY_NUM = 11n;
const EX_UNITS_SAFETY_DEN = 10n;
const HASH28_PATTERN = /^[0-9a-f]{56}$/;

function withExUnitsSafetyMargin(budget: ExUnits): ExUnits {
	return {
		mem: Number((BigInt(Math.ceil(budget.mem)) * EX_UNITS_SAFETY_NUM) / EX_UNITS_SAFETY_DEN),
		steps: Number((BigInt(Math.ceil(budget.steps)) * EX_UNITS_SAFETY_NUM) / EX_UNITS_SAFETY_DEN),
	};
}

/** Raised when the frozen body exceeds MAX_SAFE_TX_BYTES, so a caller can shrink the batch and rebuild. */
export class GuardedTxTooLargeError extends Error {
	constructor(readonly sizeBytes: number) {
		super(`guarded transaction is ${sizeBytes} bytes, above MAX_SAFE_TX_BYTES (${MAX_SAFE_TX_BYTES})`);
		this.name = 'GuardedTxTooLargeError';
	}
}

/**
 * Two-pass build: draft with default budgets, evaluate, rebuild with the
 * evaluated budgets. Each tag in `tags` must produce exactly one redeemer, and
 * no other redeemer may appear, so a budget can never land on the wrong script.
 */
export async function buildWithEvaluatedBudgets(
	provider: Pick<BlockfrostProvider, 'evaluateTx'>,
	tags: RedeemerTag[],
	build: (budgets: Budgets) => Promise<string>,
): Promise<{ tx: string; budgets: Budgets }> {
	const draft = await build(new Map(tags.map((tag) => [tag, { ...DEFAULT_EX_UNITS }])));
	const evaluated = await provider.evaluateTx(draft);
	if (evaluated.length !== tags.length) {
		throw new Error(`evaluateTx returned ${evaluated.length} redeemer budget(s); expected ${tags.length}`);
	}
	const budgets: Budgets = new Map();
	for (const tag of tags) {
		const matches = evaluated.filter((action) => action.tag === tag);
		if (matches.length !== 1) {
			throw new Error(`evaluateTx returned ${matches.length} ${tag} budget(s); expected exactly 1`);
		}
		budgets.set(tag, withExUnitsSafetyMargin(matches[0].budget));
	}
	return { tx: await build(budgets), budgets };
}

function requireBudget(budgets: Budgets, tag: RedeemerTag): ExUnits {
	const budget = budgets.get(tag);
	if (budget == null) throw new Error(`missing ${tag} budget`);
	return budget;
}

/** Protocol parameters after the V2 cost-model sync — required before any Plutus build (PPViewHashesDontMatch otherwise). */
export async function loadV2ProtocolParameters(
	provider: Pick<BlockfrostProvider, 'fetchProtocolParameters'>,
	rpcApiKey: string,
	options: { forceRefresh?: boolean } = {},
) {
	await syncMeshCostModelsFromChainV2(rpcApiKey, options);
	return getCachedChainProtocolParameters(rpcApiKey) ?? (await provider.fetchProtocolParameters());
}

export type GuardedLockOutput = { address: string; amount: Asset[]; datum: Data };

export type BuildGuardedLockParams = {
	provider: BlockfrostProvider;
	rpcApiKey: string;
	network: 'preprod' | 'mainnet';
	wallet: { scriptCode: string; address: string };
	walletUtxo: UTxO;
	walletDatum: WalletDatum;
	agentAddress: string;
	agentUtxos: UTxO[];
	/** Quorum members asked to co-sign. Declared as required signers so they land in `extra_signatories` and are priced into the fee. */
	cosignerVkhs: string[];
	locks: GuardedLockOutput[];
	nowMs?: number;
	forceRefreshCostModels?: boolean;
};

export type GuardedLockBuild = {
	unsignedTx: string;
	txHash: string;
	unsignedBytes: number;
	requiredSigners: string[];
	/** Body output index of each lock, in the order `locks` was given. The co-signer binds a purchase to its output by index. */
	lockOutputIndexes: number[];
	nextDatum: WalletDatum;
	continuingAmount: Asset[];
	outflowLovelace: bigint;
	collateral: UTxO;
	spendExUnits: ExUnits;
	validity: { invalidBefore: number; invalidAfter: number };
};

function assertGuardedLockParams(params: BuildGuardedLockParams, agentVkh: string): void {
	if (params.locks.length === 0) {
		throw new Error('a guarded lock needs at least one lock output');
	}
	if (params.walletUtxo.output.address !== params.wallet.address) {
		throw new Error('walletUtxo does not sit at the smart wallet address');
	}
	if (!params.walletUtxo.output.plutusData) {
		throw new Error('walletUtxo carries no inline datum');
	}
	if (params.walletDatum.agent !== agentVkh) {
		throw new Error('the agent key does not match the wallet datum agent');
	}
	if (params.cosignerVkhs.length === 0 || new Set(params.cosignerVkhs).size !== params.cosignerVkhs.length) {
		throw new Error('cosignerVkhs must be a non-empty list of distinct key hashes');
	}
	for (const vkh of params.cosignerVkhs) {
		if (!HASH28_PATTERN.test(vkh)) throw new Error(`co-signer key hash "${vkh}" is not 28-byte hex`);
		if (vkh === agentVkh) throw new Error('the agent key never counts toward the quorum');
	}
	for (const lock of params.locks) {
		if (lock.address === params.wallet.address) {
			throw new Error('a lock output must not pay the wallet address; the validator allows one continuing output');
		}
	}
}

/**
 * The continuing wallet output is emitted first and the locks follow in the
 * order they were given, so lock `i` sits at output `i + 1`. The co-signer
 * binds each purchase to its escrow output BY INDEX, so the layout is read back
 * out of the frozen body rather than assumed: a reordering would otherwise bind
 * a purchase to another purchase's output and be rejected as a body mismatch.
 */
function readLockOutputIndexes(txCbor: string, walletAddress: string, lockAddresses: string[]): number[] {
	const outputs = deserializeTx(txCbor).body().outputs();
	const addressAt = (index: number) => (index < outputs.length ? outputs[index].address().toBech32() : undefined);
	if (addressAt(0) !== walletAddress) {
		throw new Error('the continuing wallet output is not the first output of the frozen body');
	}
	return lockAddresses.map((address, index) => {
		if (addressAt(index + 1) !== address) {
			throw new Error(`lock ${index} is not at output ${index + 1} of the frozen body`);
		}
		return index + 1;
	});
}

export async function buildGuardedLockTx(params: BuildGuardedLockParams): Promise<GuardedLockBuild> {
	const { provider, network, wallet, walletUtxo, agentAddress, agentUtxos, locks } = params;
	const agentVkh = resolvePaymentKeyHash(agentAddress);
	assertGuardedLockParams(params, agentVkh);

	const protocolParameters = await loadV2ProtocolParameters(provider, params.rpcApiKey, {
		forceRefresh: params.forceRefreshCostModels,
	});

	const window = createTxWindow(network, { nowMs: params.nowMs });
	const slotConfig = SLOT_CONFIG_NETWORK[network];
	const continuingAmount = assetsMinus(
		walletUtxo.output.amount,
		locks.flatMap((lock) => lock.amount),
	);
	const outflow = outflowOf(walletUtxo.output.amount, continuingAmount);
	const nextDatum = applyAgentSpend(params.walletDatum, {
		outflow,
		continuingLovelace: lovelaceOf(continuingAmount),
		validity: {
			lowerMs: BigInt(slotToBeginUnixTime(window.invalidBefore, slotConfig)),
			upperMs: BigInt(slotToBeginUnixTime(window.invalidAfter, slotConfig)),
		},
	});

	const collateral = pickBatchCollateral(agentUtxos, [walletUtxo.input]);
	if (collateral == null) {
		throw new Error('the agent key holds no key-locked UTxO of at least 5 ADA to lend as collateral');
	}
	const requiredSigners = [agentVkh, ...params.cosignerVkhs];

	const buildOnce = (allowSpendingCollateral: boolean) =>
		buildWithEvaluatedBudgets(provider, ['SPEND'], async (budgets) => {
			const spend = requireBudget(budgets, 'SPEND');
			const txBuilder = new MeshTxBuilder({ fetcher: provider });
			txBuilder.protocolParams(protocolParameters);
			txBuilder
				.spendingPlutusScript('V3')
				.txIn(
					walletUtxo.input.txHash,
					walletUtxo.input.outputIndex,
					walletUtxo.output.amount,
					walletUtxo.output.address,
					0,
				)
				.txInScript(wallet.scriptCode)
				.txInRedeemerValue({ alternative: SmartWalletAction.AgentSpend, fields: [] }, 'Mesh', spend)
				.txInInlineDatumPresent()
				// Continuing output first, so the next spend finds the wallet at `<txHash>#0`.
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
				.setTotalCollateral(
					deriveTotalCollateral(
						[spend],
						protocolParameters,
						lovelaceFromUtxo(collateral),
						nativeAssetCount(collateral),
					),
				)
				// The agent pays the fee; the collateral reserve is offered only if nothing else balances.
				.selectUtxosFrom(allowSpendingCollateral ? agentUtxos : getSpendableWalletUtxos(agentUtxos, collateral));
			for (const vkh of requiredSigners) {
				txBuilder.requiredSignerHash(vkh);
			}
			// Same CIP-20 message every Masumi funds-lock carries, so a guarded
			// lock is recognisable on an explorer like any other. The quorum
			// verifier accepts auxiliary data on a guarded spend (confirmed on
			// preprod in bed7b545…, which co-signed and landed with this label).
			return await txBuilder
				.changeAddress(agentAddress)
				.invalidBefore(window.invalidBefore)
				.invalidHereafter(window.invalidAfter)
				.setNetwork(network)
				.metadataValue(674, { msg: ['Masumi', 'PaymentBatched'] })
				.complete();
		});

	let built: { tx: string; budgets: Budgets };
	try {
		built = await buildOnce(false);
	} catch (error) {
		if (!isInsufficientBalanceBuildError(error)) throw error;
		built = await buildOnce(true);
	}

	if (!isTxSizeWithinLimit(built.tx)) {
		throw new GuardedTxTooLargeError(Math.floor(built.tx.length / 2));
	}

	return {
		unsignedTx: built.tx,
		txHash: resolveTxHash(built.tx),
		unsignedBytes: Math.floor(built.tx.length / 2),
		requiredSigners,
		lockOutputIndexes: readLockOutputIndexes(
			built.tx,
			wallet.address,
			locks.map((lock) => lock.address),
		),
		nextDatum,
		continuingAmount,
		outflowLovelace: lovelaceOf(walletUtxo.output.amount) - lovelaceOf(continuingAmount),
		collateral,
		spendExUnits: requireBudget(built.budgets, 'SPEND'),
		validity: { invalidBefore: window.invalidBefore, invalidAfter: window.invalidAfter },
	};
}
