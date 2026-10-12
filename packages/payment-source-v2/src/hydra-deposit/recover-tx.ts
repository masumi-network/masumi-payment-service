// Mesh SDK pinning: V2 package, V2 mesh line (ADR 0005). The recover is a plain
// L1 Plutus V3 spend; it needs the V2 cost-model sync like every V2 build.
//
// Recover a Hydra deposit on L1 without the head's node.
//
// hydra 2.4.1 `deposit.ak` checks three things for `Recover(n)` and no signer:
//   1. the lower validity bound is after the datum deadline (`D04`),
//   2. the deposit is the only input at the deposit script (`D10`),
//   3. the first `n` outputs hash to the commits sorted by output reference (`D05`).
// `Hydra.Tx.Recover.recoverTx` builds the same shape (no required signer), so any
// wallet may post it: here a hot wallet pays the fee and lends the collateral,
// and every committed output goes back to its original address unchanged.
import {
	applyCborEncoding,
	BlockfrostProvider,
	deserializeAddress,
	MeshTxBuilder,
	MeshWallet,
	resolveTxHash,
	slotToBeginUnixTime,
	unixTimeToEnclosingSlot,
	type SlotConfig,
	type UTxO,
} from '@meshsdk/core';
import {
	deriveTotalCollateral,
	getSpendableWalletUtxos,
	lovelaceFromUtxo,
	nativeAssetCount,
	pickBatchCollateral,
} from '../builders/batch-helpers';
import { buildWithEvaluatedBudgets, loadV2ProtocolParameters } from '../smart-wallet/guarded-lock-builder';
import { DepositDatumError, parseDepositDatum, type CardanoNetworkId, type DepositDatum } from './deposit-datum';
import { HYDRA_DEPOSIT_COMPILED_CODE, HYDRA_DEPOSIT_SCRIPT_HASH } from './deposit-script';

type MeshNetwork = 'preprod' | 'mainnet';

// `Recover` is constructor 1 of `DepositRedeemer` (`Claim` is 0); see deposit.ak.
const RECOVER_ALTERNATIVE = 1;

/**
 * The node checks the lower bound against its own tip. Waiting this long past the
 * first valid slot keeps a lagging tip from rejecting the recover as too early.
 */
export const RECOVER_TIP_MARGIN_MS = 2 * 60 * 1000;

/**
 * The recover expires this long after it is built. A recover that was dropped
 * cannot land later, so its fee wallet can be released once this has passed.
 */
export const RECOVER_VALIDITY_MS = 10 * 60 * 1000;

/** The deposit cannot be recovered on L1 now. `reason` says why. */
export class DepositNotRecoverableError extends Error {
	constructor(
		readonly reason: 'not-found' | 'spent' | 'too-early' | 'wrong-head',
		message: string,
	) {
		super(message);
		this.name = 'DepositNotRecoverableError';
	}
}

const DEPOSIT_SCRIPT_CODE = applyCborEncoding(HYDRA_DEPOSIT_COMPILED_CODE);

function networkIdOf(network: MeshNetwork): CardanoNetworkId {
	return network === 'mainnet' ? 1 : 0;
}

/** The first slot whose start is strictly after the deadline, as `after_deadline` requires. */
export function firstRecoverSlot(deadlineMs: bigint, slotConfig: SlotConfig): number {
	return unixTimeToEnclosingSlot(Number(deadlineMs), slotConfig) + 1;
}

type BlockfrostTxUtxos = {
	outputs: Array<{ address: string; output_index: number; consumed_by_tx?: string | null }>;
};

/**
 * The unspent deposit output of `depositTxHash`. Blockfrost names the spender of
 * a spent output, which tells a recovered or absorbed deposit from a live one.
 */
export async function fetchDepositUtxo(
	provider: Pick<BlockfrostProvider, 'get' | 'fetchUTxOs'>,
	depositTxHash: string,
): Promise<UTxO> {
	let raw: BlockfrostTxUtxos;
	try {
		raw = (await provider.get(`txs/${depositTxHash}/utxos`)) as BlockfrostTxUtxos;
	} catch (error) {
		// Mesh throws the Blockfrost answer as a JSON string. Only a 404 says the
		// transaction is absent; a rate limit or outage is not an answer.
		const detail = error instanceof Error ? error.message : String(error);
		if (detail.includes('"status":404')) {
			throw new DepositNotRecoverableError('not-found', `The deposit ${depositTxHash} is not on L1`);
		}
		throw new Error(`Could not read the deposit ${depositTxHash} from L1: ${detail}`);
	}
	const atScript = (raw.outputs ?? []).filter(
		(output) => deserializeAddress(output.address).scriptHash === HYDRA_DEPOSIT_SCRIPT_HASH,
	);
	if (atScript.length !== 1) {
		throw new DepositNotRecoverableError(
			'not-found',
			`The transaction ${depositTxHash} has ${atScript.length} outputs at the Hydra deposit script, expected 1`,
		);
	}
	const [deposit] = atScript;
	if (deposit.consumed_by_tx != null) {
		throw new DepositNotRecoverableError(
			'spent',
			`The deposit was already spent by ${deposit.consumed_by_tx}: the head took it in or it was recovered`,
		);
	}
	const [utxo] = await provider.fetchUTxOs(depositTxHash, deposit.output_index);
	if (utxo?.output.plutusData == null) {
		throw new DepositNotRecoverableError('not-found', 'The deposit output carries no inline datum');
	}
	return utxo;
}

export type DepositRecoverBuild = {
	unsignedTx: string;
	txHash: string;
	datum: DepositDatum;
	/** After this the recover can no longer land. */
	validUntilMs: number;
};

function sumByUnit(assets: Array<{ unit: string; quantity: string }>): Map<string, bigint> {
	const totals = new Map<string, bigint>();
	for (const asset of assets) totals.set(asset.unit, (totals.get(asset.unit) ?? 0n) + BigInt(asset.quantity));
	return totals;
}

// The validator never ties the commits to the deposit value. Commits worth more
// than the deposit would have coin selection pay the gap from the fee wallet.
function assertCommitsWithinDeposit(datum: DepositDatum, depositUtxo: UTxO): void {
	const held = sumByUnit(depositUtxo.output.amount);
	for (const [unit, quantity] of sumByUnit(datum.commits.flatMap((commit) => commit.output.amount))) {
		if (quantity > (held.get(unit) ?? 0n)) {
			throw new DepositDatumError(`The deposit datum commits more ${unit} than the deposit holds`);
		}
	}
}

/**
 * Build the recover of one deposit UTxO. The fee wallet pays the fee, lends the
 * collateral and takes the change; the committed outputs come first, in order.
 */
export async function buildDepositRecoverTx(params: {
	provider: Pick<BlockfrostProvider, 'evaluateTx' | 'fetchProtocolParameters'>;
	rpcApiKey: string;
	network: MeshNetwork;
	slotConfig: SlotConfig;
	depositUtxo: UTxO;
	expectedHeadId?: string;
	feeAddress: string;
	feeUtxos: UTxO[];
	nowMs?: number;
}): Promise<DepositRecoverBuild> {
	const { depositUtxo, slotConfig } = params;
	const datum = parseDepositDatum(depositUtxo.output.plutusData ?? '', networkIdOf(params.network));
	assertCommitsWithinDeposit(datum, depositUtxo);
	if (params.expectedHeadId != null && datum.headId !== params.expectedHeadId.toLowerCase()) {
		throw new DepositNotRecoverableError('wrong-head', `The deposit belongs to head ${datum.headId}`);
	}
	const lowerSlot = firstRecoverSlot(datum.deadlineMs, slotConfig);
	const recoverableAtMs = slotToBeginUnixTime(lowerSlot, slotConfig) + RECOVER_TIP_MARGIN_MS;
	const nowMs = params.nowMs ?? Date.now();
	if (nowMs < recoverableAtMs) {
		throw new DepositNotRecoverableError(
			'too-early',
			`The deposit can be recovered on L1 from ${new Date(recoverableAtMs).toISOString()}`,
		);
	}
	// Fee inputs must be plain outputs; the deposit stays the only script input.
	const plain = params.feeUtxos.filter((utxo) => utxo.output.plutusData == null && !utxo.output.scriptRef);
	const collateral = pickBatchCollateral(plain, [depositUtxo.input]);
	if (collateral == null) {
		throw new Error('The fee wallet holds no key-locked UTxO of at least 5 ADA to lend as collateral');
	}
	const protocolParameters = await loadV2ProtocolParameters(params.provider, params.rpcApiKey);
	const upperSlot = unixTimeToEnclosingSlot(nowMs + RECOVER_VALIDITY_MS, slotConfig);

	const { tx } = await buildWithEvaluatedBudgets(params.provider, ['SPEND'], async (budgets) => {
		const spend = budgets.get('SPEND');
		if (spend == null) throw new Error('missing SPEND budget');
		const builder = new MeshTxBuilder({ fetcher: params.provider as BlockfrostProvider });
		builder.protocolParams(protocolParameters);
		builder
			.spendingPlutusScript('V3')
			.txIn(
				depositUtxo.input.txHash,
				depositUtxo.input.outputIndex,
				depositUtxo.output.amount,
				depositUtxo.output.address,
				0,
			)
			.txInScript(DEPOSIT_SCRIPT_CODE)
			.txInRedeemerValue({ alternative: RECOVER_ALTERNATIVE, fields: [datum.commits.length] }, 'Mesh', spend)
			.txInInlineDatumPresent();
		for (const { output } of datum.commits) {
			builder.txOut(output.address, output.amount);
			if (output.inlineDatumCbor != null) builder.txOutInlineDatumValue(output.inlineDatumCbor, 'CBOR');
		}
		return await builder
			.invalidBefore(lowerSlot)
			.invalidHereafter(upperSlot)
			.txInCollateral(
				collateral.input.txHash,
				collateral.input.outputIndex,
				collateral.output.amount,
				collateral.output.address,
			)
			.setTotalCollateral(
				deriveTotalCollateral([spend], protocolParameters, lovelaceFromUtxo(collateral), nativeAssetCount(collateral)),
			)
			.selectUtxosFrom(getSpendableWalletUtxos(plain, collateral))
			.changeAddress(params.feeAddress)
			.setNetwork(params.network)
			.complete();
	});
	return {
		unsignedTx: tx,
		txHash: resolveTxHash(tx),
		datum,
		validUntilMs: slotToBeginUnixTime(upperSlot, slotConfig),
	};
}

/**
 * Recover `depositTxHash` with the hot wallet `mnemonic` paying the fee, and
 * submit it. `onSigned` gets the hash and expiry before the submit, so a caller
 * can track a transaction that may land even when the submit answer is lost.
 */
export async function recoverDepositOnL1(params: {
	rpcApiKey: string;
	network: MeshNetwork;
	slotConfig: SlotConfig;
	depositTxHash: string;
	expectedHeadId?: string;
	mnemonic: string[];
	onSigned?: (signed: { txHash: string; validUntilMs: number }) => Promise<void>;
}): Promise<{ txHash: string; datum: DepositDatum; validUntilMs: number }> {
	const provider = new BlockfrostProvider(params.rpcApiKey);
	const depositUtxo = await fetchDepositUtxo(provider, params.depositTxHash);
	const wallet = new MeshWallet({
		networkId: networkIdOf(params.network),
		fetcher: provider,
		submitter: provider,
		key: { type: 'mnemonic', words: params.mnemonic },
	});
	await wallet.init();
	const built = await buildDepositRecoverTx({
		provider,
		rpcApiKey: params.rpcApiKey,
		network: params.network,
		slotConfig: params.slotConfig,
		depositUtxo,
		expectedHeadId: params.expectedHeadId,
		feeAddress: await wallet.getChangeAddress(),
		feeUtxos: await wallet.getUtxos(),
	});
	const signed = await wallet.signTx(built.unsignedTx);
	await params.onSigned?.({ txHash: built.txHash, validUntilMs: built.validUntilMs });
	await wallet.submitTx(signed);
	return { txHash: built.txHash, datum: built.datum, validUntilMs: built.validUntilMs };
}
