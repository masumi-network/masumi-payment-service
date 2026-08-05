import { Address, Transaction, type TransactionOutput } from '@emurgo/cardano-serialization-lib-nodejs';
import { resolveTxHash } from '@meshsdk/core';

import { HYDRA_HEAD_V2_ASSET_NAME_HEX, resolveHydraHeadScriptHash } from './head-init-validation';
import { serializeCardanoTransactionOutput, type VerifiedHydraFanoutReference } from './snapshot-verification';
import { MAX_HYDRA_SNAPSHOT_OUTPUTS } from './schemas';

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

/**
 * Bounds on the work one verification may ask of the L1 observer.
 *
 * A fanout chain is driven by data hydra-node reports, and each step costs four
 * indexer requests. These are not protocol limits — they are the point past
 * which a malformed or hostile finalization stops being a verification failure
 * and becomes a way to keep this process busy. `MAX_HYDRA_SNAPSHOT_OUTPUTS` is
 * the head's own ceiling on outputs, and a step distributes at least one, so no
 * honest chain can exceed either.
 */
const MAX_FANOUT_REFERENCES = MAX_HYDRA_SNAPSHOT_OUTPUTS;
const MAX_FANOUT_STEPS = MAX_HYDRA_SNAPSHOT_OUTPUTS;

/**
 * A CSL output's value as the flat unit/quantity pairs the indexer reports.
 *
 * Only needed for the continuing head output of a partial step, which exists
 * solely in the transaction body — there is no indexed UTxO row for it yet, so
 * its tokens cannot be read the way an input's are.
 */
function serializeCardanoOutputAmounts(output: TransactionOutput): Array<{ unit: string; quantity: string }> {
	const amounts: Array<{ unit: string; quantity: string }> = [];
	const value = output.amount();
	amounts.push({ unit: 'lovelace', quantity: value.coin().to_str() });
	const multiasset = value.multiasset();
	if (!multiasset) return amounts;
	const policies = multiasset.keys();
	for (let policyIndex = 0; policyIndex < policies.len(); policyIndex += 1) {
		const policy = policies.get(policyIndex);
		const assets = multiasset.get(policy);
		if (!assets) continue;
		const names = assets.keys();
		for (let assetIndex = 0; assetIndex < names.len(); assetIndex += 1) {
			const name = names.get(assetIndex);
			const quantity = assets.get(name);
			if (!quantity) continue;
			amounts.push({
				unit: `${policy.to_hex().toLowerCase()}${Buffer.from(name.name()).toString('hex').toLowerCase()}`,
				quantity: quantity.to_str(),
			});
		}
	}
	return amounts;
}

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

/** One transaction's place in the fanout chain, decided by what it burns. */
type FanoutStepRole = 'partial' | 'terminal';

type VerifiedFanoutStep = {
	transaction: VerifiedHydraFanoutTransaction;
	role: FanoutStepRole;
	/** The head state-machine output this step consumed, as `txHash#index`. */
	headInputReference: string;
	/** Where this step's distributed outputs begin. */
	firstDistributedIndex: number;
};

/**
 * Verify one transaction of a fanout, whatever its place in the chain.
 *
 * The two shapes come straight from hydra-node's own builders. A terminal step
 * (`fanoutTx` or `finalPartialFanoutTx`) burns the head token set and its
 * outputs are all distributed, starting at index 0. An intermediate step
 * (`partialFanoutTx`) burns nothing: its first output is the head carried
 * forward with the tokens and a reduced value, and only the outputs after it
 * are distributed.
 *
 * Which one this is, is read off the burn rather than trusted from anywhere —
 * the burn is what actually ends the head on chain.
 */
async function verifyFanoutStep(params: {
	observer: HydraFanoutChainObserver;
	txHash: string;
	headId: string;
	expectedUnits: ReadonlySet<string>;
	headScriptHash: string;
	references: readonly VerifiedHydraFanoutReference[];
	requiredConfirmations: number;
	observerTimeoutMs: number;
}): Promise<VerifiedFanoutStep> {
	const { observer, txHash, headId, expectedUnits, headScriptHash, references, requiredConfirmations } = params;

	if (new Set(references.map(({ outputIndex }) => outputIndex)).size !== references.length) {
		fail('Hydra finalized outputs repeated an L1 output index');
	}

	const { details, block, cborResponse, utxos } = await withObserverTimeout(
		(async () => {
			const details = await observer.txs(txHash);
			const [block, cborResponse, utxos] = await Promise.all([
				observer.blocks(details.block),
				observer.txsCbor(txHash),
				observer.txsUtxos(txHash),
			]);
			return { details, block, cborResponse, utxos };
		})(),
		params.observerTimeoutMs,
	);
	if (
		normalizeHex(details.hash, 64, 'Hydra fanout transaction response hash') !== txHash ||
		normalizeHex(utxos.hash, 64, 'Hydra fanout UTxO response hash') !== txHash ||
		details.valid_contract !== true
	) {
		fail('Hydra fanout transaction identity or phase-2 validity was not independently confirmed');
	}
	const confirmations = block.confirmations ?? 0;
	if (!Number.isSafeInteger(confirmations) || confirmations < requiredConfirmations) {
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

	// Every step spends the head state-machine output, and the head tokens ride
	// along the whole chain until the terminal step burns them. So this check is
	// identical for a partial step and a final one.
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
	const headInputReference = `${normalizeHex(indexedHeadInput.tx_hash, 64, 'Hydra vHead input tx hash')}#${
		indexedHeadInput.output_index
	}`;
	if (
		!Number.isSafeInteger(indexedHeadInput.output_index) ||
		indexedHeadInput.output_index < 0 ||
		!bodyInputReferences.has(headInputReference)
	) {
		fail('Hydra fanout CBOR did not consume its independently indexed bound vHead input');
	}

	const mintedHeadPolicy = mintPolicyAmounts(transaction, headId);
	const burnsHeadTokens = hasExactTokenSet(mintedHeadPolicy, expectedUnits, -1n);
	const role: FanoutStepRole = burnsHeadTokens ? 'terminal' : 'partial';
	if (role === 'partial' && mintedHeadPolicy.size !== 0) {
		// A partial step must leave the head's tokens completely alone. Anything
		// else is neither shape hydra-node builds.
		fail('Hydra partial fanout minted or burned head-policy tokens');
	}

	const outputs = transaction.body().outputs();
	// A partial step carries the head forward as its first output; a terminal
	// step has none. Everything after that point is distributed value.
	const firstDistributedIndex = role === 'partial' ? 1 : 0;
	if (role === 'partial') {
		if (outputs.len() < 2) fail('Hydra partial fanout produced no continuing head output');
		const continuingHead = outputs.get(0);
		const continuingAddress = continuingHead.address().to_bech32();
		if (paymentScriptHash(continuingAddress) !== headScriptHash) {
			fail('Hydra partial fanout did not carry the head forward at the head script address');
		}
		const continuingAmounts = serializeCardanoOutputAmounts(continuingHead);
		if (!hasExactTokenSet(headPolicyAmounts(continuingAmounts, headId), expectedUnits, 1n)) {
			fail('Hydra partial fanout continuing head output did not carry the exact bound head token set');
		}
	}

	const distributedCount = outputs.len() - firstDistributedIndex;
	const referencedIndices = new Set(references.map(({ outputIndex }) => outputIndex));
	if (
		distributedCount !== references.length ||
		referencedIndices.size !== distributedCount ||
		Array.from({ length: distributedCount }, (_, offset) => offset + firstDistributedIndex).some(
			(index) => !referencedIndices.has(index),
		)
	) {
		fail('Hydra finalized output map did not cover the complete L1 fanout output sequence');
	}
	for (const reference of references) {
		if (
			!Number.isSafeInteger(reference.outputIndex) ||
			reference.outputIndex < firstDistributedIndex ||
			reference.outputIndex >= outputs.len() ||
			serializeCardanoTransactionOutput(outputs.get(reference.outputIndex)) !== reference.serializedOutput
		) {
			fail('Hydra fanout L1 output did not match the signed final snapshot output');
		}
	}

	return {
		role,
		headInputReference,
		firstDistributedIndex,
		transaction: {
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
		},
	};
}

/**
 * Independently prove that hydra-node's reported references are the real L1
 * fanout of the durably bound head.
 *
 * The signed snapshot authenticates TxOut values only. This verifier adds the
 * missing reference binding by requiring every step to consume the official
 * vHead output carrying the expected head tokens, then byte-comparing each
 * adopted output with the signed snapshot value. Confirmation depth protects
 * the irreversible ownership handoff from ordinary L1 rollbacks.
 *
 * A head too large to empty in one transaction is fanned out over several
 * (hydra-node 2.2.0's partial fanout), so this proves a *chain* rather than a
 * transaction. Two properties make the chain as binding as the single
 * transaction it replaces:
 *
 *   - Each step after the first spends the head output the previous step
 *     produced, so the steps form one unbranched line rather than a set of
 *     transactions that merely mention the same head.
 *   - Exactly one step burns the head tokens, and it is the last. That burn is
 *     what ends the head on chain, so it cannot be in the middle and cannot
 *     happen twice.
 *
 * The caller's own multiset check — every signed output accounted for exactly
 * once across the whole chain — remains what proves nothing was left behind.
 *
 * Returns the steps in chain order; the last is the terminal one.
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
}): Promise<VerifiedHydraFanoutTransaction[]> {
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
	if (options.references.length > MAX_FANOUT_REFERENCES) {
		fail('Hydra fanout verification received more references than a head can hold');
	}

	const byTxHash = new Map<string, VerifiedHydraFanoutReference[]>();
	for (const reference of options.references) {
		const txHash = normalizeHex(reference.txHash, 64, 'Hydra fanout tx hash');
		const group = byTxHash.get(txHash);
		if (group) group.push(reference);
		else byTxHash.set(txHash, [reference]);
	}
	if (byTxHash.size > MAX_FANOUT_STEPS) fail('Hydra fanout spanned more L1 transactions than a head can produce');

	const expectedUnits = new Set([
		`${headId}${HYDRA_HEAD_V2_ASSET_NAME_HEX}`,
		...participantVkeys.map((vkey) => `${headId}${vkey}`),
	]);
	const headScriptHash = resolveHydraHeadScriptHash(options.headScriptHash);

	// Verified independently; the chain they form is checked afterwards, because
	// no single step can prove anything about the ones around it.
	const steps = new Map<string, VerifiedFanoutStep>();
	for (const [txHash, references] of byTxHash) {
		steps.set(
			txHash,
			await verifyFanoutStep({
				observer: options.observer,
				txHash,
				headId,
				expectedUnits,
				headScriptHash,
				references,
				requiredConfirmations: options.requiredConfirmations,
				observerTimeoutMs,
			}),
		);
	}

	const terminals = [...steps.values()].filter((step) => step.role === 'terminal');
	if (terminals.length !== 1) {
		fail('Hydra fanout did not burn the exact bound head and participant token set exactly once');
	}

	// Walk the chain backwards from the terminal step: each step's head input is
	// the previous step's first output. Following the links rather than trusting
	// an order means a step that belongs to some other head's fanout, or a second
	// branch off the same head output, cannot be spliced in.
	const chain: VerifiedFanoutStep[] = [];
	const seen = new Set<string>();
	let cursor: VerifiedFanoutStep | undefined = terminals[0];
	while (cursor) {
		if (seen.has(cursor.transaction.txHash)) fail('Hydra fanout chain revisited a transaction');
		seen.add(cursor.transaction.txHash);
		chain.push(cursor);
		const [previousTxHash, previousIndex] = cursor.headInputReference.split('#');
		const previous = steps.get(previousTxHash ?? '');
		if (!previous) break;
		// A partial step carries the head forward as its own first output, so that
		// is the only place the next step may pick it up.
		if (previousIndex !== '0' || previous.role !== 'partial') {
			fail('Hydra fanout step did not consume the continuing head output of its predecessor');
		}
		cursor = previous;
	}
	if (chain.length !== steps.size) {
		fail('Hydra fanout produced transactions outside the chain ending in its token burn');
	}

	return chain.reverse().map((step) => step.transaction);
}
