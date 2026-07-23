import { Address, Transaction } from '@emurgo/cardano-serialization-lib-nodejs';
import { resolveTxHash } from '@meshsdk/core';

import { HYDRA_HEAD_V2_ASSET_NAME_HEX, resolveHydraHeadScriptHash } from './head-init-validation';
import { serializeCardanoTransactionOutput, type VerifiedHydraFanoutReference } from './snapshot-verification';

type FanoutChainInput = {
	tx_hash: string;
	output_index: number;
	address: string;
	amount: Array<{ unit: string; quantity: string }>;
	collateral?: boolean;
	reference?: boolean;
};

export type HydraFanoutChainObserver = {
	txs: (txHash: string) => Promise<{
		hash: string;
		block: string;
		block_height: number;
		block_time: number;
		fees: string;
		output_amount: Array<{ unit: string; quantity: string }>;
		utxo_count: number;
		withdrawal_count: number;
		asset_mint_or_burn_count: number;
		redeemer_count: number;
		valid_contract: boolean;
	}>;
	blocks: (blockHash: string) => Promise<{ confirmations?: number | null }>;
	txsCbor: (txHash: string) => Promise<{ cbor: string }>;
	txsUtxos: (txHash: string) => Promise<{
		hash: string;
		inputs: FanoutChainInput[];
	}>;
};

export type VerifiedHydraFanoutTransaction = {
	txHash: string;
	confirmations: number;
	fees: bigint;
	blockHeight: number;
	blockTime: number;
	outputAmount: string;
	utxoCount: number;
	withdrawalCount: number;
	assetMintOrBurnCount: number;
	redeemerCount: number;
	validContract: boolean;
};

export class HydraFanoutValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'HydraFanoutValidationError';
	}
}

const DEFAULT_FANOUT_OBSERVER_TIMEOUT_MS = 15_000;

function fail(message: string): never {
	throw new HydraFanoutValidationError(message);
}

async function withObserverTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(
					() => reject(new HydraFanoutValidationError('Hydra fanout L1 observer timed out')),
					timeoutMs,
				);
				timeout.unref?.();
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

function normalizeHex(value: string, length: number, label: string): string {
	const normalized = value.toLowerCase();
	if (normalized.length !== length || !/^[0-9a-f]+$/.test(normalized)) fail(`${label} was not canonical hex`);
	return normalized;
}

function paymentScriptHash(address: string): string | null {
	try {
		return Address.from_bech32(address).payment_cred()?.to_scripthash()?.to_hex().toLowerCase() ?? null;
	} catch {
		return null;
	}
}

function headPolicyAmounts(
	amounts: ReadonlyArray<{ unit: string; quantity: string }>,
	headId: string,
): Map<string, bigint> {
	const result = new Map<string, bigint>();
	for (const amount of amounts) {
		const unit = amount.unit.toLowerCase();
		if (!unit.startsWith(headId)) continue;
		let quantity: bigint;
		try {
			quantity = BigInt(amount.quantity);
		} catch {
			fail('Hydra fanout input contained an invalid token quantity');
		}
		result.set(unit, (result.get(unit) ?? 0n) + quantity);
	}
	return result;
}

function mintPolicyAmounts(transaction: Transaction, headId: string): Map<string, bigint> {
	const mint = transaction.body().mint();
	if (!mint) return new Map();
	const result = new Map<string, bigint>();
	const policies = mint.keys();
	for (let policyIndex = 0; policyIndex < policies.len(); policyIndex += 1) {
		const policy = policies.get(policyIndex);
		if (policy.to_hex().toLowerCase() !== headId) continue;
		const groups = mint.get(policy);
		if (!groups) fail('Hydra fanout mint omitted its head-policy asset group');
		for (let groupIndex = 0; groupIndex < groups.len(); groupIndex += 1) {
			const assets = groups.get(groupIndex);
			if (!assets) fail('Hydra fanout mint contained an invalid head-policy asset group');
			const names = assets.keys();
			for (let assetIndex = 0; assetIndex < names.len(); assetIndex += 1) {
				const name = names.get(assetIndex);
				const quantity = assets.get(name);
				if (!quantity) fail('Hydra fanout mint omitted a head-policy quantity');
				const positive = quantity.as_positive();
				const negative = quantity.as_negative();
				const signedQuantity = positive ? BigInt(positive.to_str()) : negative ? -BigInt(negative.to_str()) : 0n;
				const unit = `${headId}${Buffer.from(name.name()).toString('hex').toLowerCase()}`;
				result.set(unit, (result.get(unit) ?? 0n) + signedQuantity);
			}
		}
	}
	return result;
}

function hasExactTokenSet(
	actual: ReadonlyMap<string, bigint>,
	expectedUnits: ReadonlySet<string>,
	expectedQuantity: bigint,
): boolean {
	return (
		actual.size === expectedUnits.size &&
		[...expectedUnits].every((unit) => actual.get(unit) === expectedQuantity) &&
		[...actual].every(([unit]) => expectedUnits.has(unit))
	);
}

/**
 * Independently prove that hydra-node's reported reference is the real L1
 * fanout transaction for the durably bound head.
 *
 * The signed snapshot authenticates TxOut values only. This verifier adds the
 * missing reference binding by requiring the indexed transaction to consume
 * the official vHead output carrying every expected head token and burn that
 * exact token set, then byte-compares each adopted output with the signed
 * snapshot value. Confirmation depth protects the irreversible ownership
 * handoff from ordinary L1 rollbacks.
 */
export async function verifyHydraFanoutOnChain(options: {
	observer: HydraFanoutChainObserver;
	headId: string;
	participantVkeys: readonly string[];
	references: readonly VerifiedHydraFanoutReference[];
	requiredConfirmations: number;
	headScriptHash?: string;
	/** Bounds the complete independent observer pass; underlying requests may finish later. */
	observerTimeoutMs?: number;
}): Promise<VerifiedHydraFanoutTransaction> {
	const headId = normalizeHex(options.headId, 56, 'Hydra head id');
	if (options.participantVkeys.length !== 2) fail('Hydra fanout verification requires exactly two participants');
	const participantVkeys = options.participantVkeys.map((vkey, index) =>
		normalizeHex(vkey, 56, `Hydra participant ${index}`),
	);
	if (new Set(participantVkeys).size !== participantVkeys.length) fail('Hydra fanout participants were not unique');
	if (
		!Number.isSafeInteger(options.requiredConfirmations) ||
		options.requiredConfirmations < 0 ||
		options.references.length === 0
	) {
		fail('Hydra fanout verification received invalid confirmation/reference requirements');
	}
	const observerTimeoutMs = options.observerTimeoutMs ?? DEFAULT_FANOUT_OBSERVER_TIMEOUT_MS;
	if (!Number.isSafeInteger(observerTimeoutMs) || observerTimeoutMs <= 0 || observerTimeoutMs > 60_000) {
		fail('Hydra fanout verification received an invalid observer timeout');
	}
	const txHashes = new Set(options.references.map(({ txHash }) => normalizeHex(txHash, 64, 'Hydra fanout tx hash')));
	if (txHashes.size !== 1) fail('Hydra finalized outputs did not share one L1 fanout transaction');
	const txHash = [...txHashes][0];
	if (new Set(options.references.map(({ outputIndex }) => outputIndex)).size !== options.references.length) {
		fail('Hydra finalized outputs repeated an L1 output index');
	}

	const { details, block, cborResponse, utxos } = await withObserverTimeout(
		(async () => {
			const details = await options.observer.txs(txHash);
			const [block, cborResponse, utxos] = await Promise.all([
				options.observer.blocks(details.block),
				options.observer.txsCbor(txHash),
				options.observer.txsUtxos(txHash),
			]);
			return { details, block, cborResponse, utxos };
		})(),
		observerTimeoutMs,
	);
	if (
		normalizeHex(details.hash, 64, 'Hydra fanout transaction response hash') !== txHash ||
		normalizeHex(utxos.hash, 64, 'Hydra fanout UTxO response hash') !== txHash ||
		details.valid_contract !== true
	) {
		fail('Hydra fanout transaction identity or phase-2 validity was not independently confirmed');
	}
	const confirmations = block.confirmations ?? 0;
	if (!Number.isSafeInteger(confirmations) || confirmations < options.requiredConfirmations) {
		fail('Hydra fanout transaction has not reached the required L1 confirmation depth');
	}

	let transaction: Transaction;
	try {
		transaction = Transaction.from_bytes(Buffer.from(cborResponse.cbor, 'hex'));
	} catch {
		fail('Hydra fanout transaction CBOR was invalid');
	}
	if (!transaction.is_valid()) fail('Hydra fanout transaction CBOR was phase-2 invalid');
	if (String(resolveTxHash(cborResponse.cbor)).toLowerCase() !== txHash) {
		fail('Hydra fanout transaction CBOR hash did not match its indexed hash');
	}

	const expectedUnits = new Set([
		`${headId}${HYDRA_HEAD_V2_ASSET_NAME_HEX}`,
		...participantVkeys.map((vkey) => `${headId}${vkey}`),
	]);
	const headScriptHash = resolveHydraHeadScriptHash(options.headScriptHash);
	const headInputs = utxos.inputs.filter(
		(input) =>
			input.collateral !== true &&
			input.reference !== true &&
			paymentScriptHash(input.address) === headScriptHash &&
			hasExactTokenSet(headPolicyAmounts(input.amount, headId), expectedUnits, 1n),
	);
	if (headInputs.length !== 1) fail('Hydra fanout did not consume exactly one bound official vHead token output');
	const bodyInputs = transaction.body().inputs();
	const bodyInputReferences = new Set<string>();
	for (let index = 0; index < bodyInputs.len(); index += 1) {
		const input = bodyInputs.get(index);
		bodyInputReferences.add(`${input.transaction_id().to_hex().toLowerCase()}#${input.index()}`);
	}
	const indexedHeadInput = headInputs[0];
	const indexedHeadReference = `${normalizeHex(indexedHeadInput.tx_hash, 64, 'Hydra vHead input tx hash')}#${
		indexedHeadInput.output_index
	}`;
	if (
		!Number.isSafeInteger(indexedHeadInput.output_index) ||
		indexedHeadInput.output_index < 0 ||
		!bodyInputReferences.has(indexedHeadReference)
	) {
		fail('Hydra fanout CBOR did not consume its independently indexed bound vHead input');
	}
	if (!hasExactTokenSet(mintPolicyAmounts(transaction, headId), expectedUnits, -1n)) {
		fail('Hydra fanout did not burn the exact bound head and participant token set');
	}

	const outputs = transaction.body().outputs();
	const referencedIndices = new Set(options.references.map(({ outputIndex }) => outputIndex));
	if (
		outputs.len() !== options.references.length ||
		referencedIndices.size !== outputs.len() ||
		Array.from({ length: outputs.len() }, (_, index) => index).some((index) => !referencedIndices.has(index))
	) {
		fail('Hydra finalized output map did not cover the complete L1 fanout output sequence');
	}
	for (const reference of options.references) {
		if (
			!Number.isSafeInteger(reference.outputIndex) ||
			reference.outputIndex < 0 ||
			reference.outputIndex >= outputs.len() ||
			serializeCardanoTransactionOutput(outputs.get(reference.outputIndex)) !== reference.serializedOutput
		) {
			fail('Hydra fanout L1 output did not match the signed final snapshot output');
		}
	}

	return {
		txHash,
		confirmations,
		fees: BigInt(details.fees),
		blockHeight: details.block_height,
		blockTime: details.block_time,
		outputAmount: JSON.stringify(details.output_amount),
		utxoCount: details.utxo_count,
		withdrawalCount: details.withdrawal_count,
		assetMintOrBurnCount: details.asset_mint_or_burn_count,
		redeemerCount: details.redeemer_count,
		validContract: details.valid_contract,
	};
}
