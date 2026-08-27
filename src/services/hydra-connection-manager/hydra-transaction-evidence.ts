import { FixedTransaction, PlutusDatumSchema, RedeemerTagKind } from '@emurgo/cardano-serialization-lib-nodejs';
import type { SlotConfig } from '@meshsdk/core';

export type HydraInputReference = {
	txHash: string;
	outputIndex: number;
	bodyIndex: number;
};

export type HydraSpendEvidence = HydraInputReference & {
	redeemerVersion: number;
};

export type HydraOutputEvidence = {
	outputIndex: number;
	address: string;
	amount: Array<{ unit: string; quantity: string }>;
	plutusData: string | null;
};

export type HydraTransactionEvidence = {
	txHash: string;
	/** Signed transaction-body `validity_start_interval` slot. */
	validityLowerSlot: bigint | null;
	/** Signed transaction-body `invalid_hereafter` slot (`ttl` in CSL). */
	validityUpperSlot: bigint | null;
	inputs: HydraInputReference[];
	spends: HydraSpendEvidence[];
	outputs: HydraOutputEvidence[];
	/** Payment-key hashes of every cryptographically verified tx witness. */
	signerVkeys: string[];
	/** Payment-key hashes committed by the body as required signers. */
	requiredSignerVkeys: string[];
};

export type HydraAmount = { unit: string; quantity: string };

function canonicalHydraUnit(unit: string): string {
	return unit === '' || unit.toLowerCase() === 'lovelace' ? 'lovelace' : unit.toLowerCase();
}

/**
 * Turn a Cardano value list into one deterministic row per asset. Reject
 * malformed/negative quantities instead of letting duplicate rows influence
 * callers that use `find` or count rows rather than summing the value.
 */
export function canonicalizeHydraAmounts(amounts: readonly HydraAmount[]): HydraAmount[] | null {
	const normalized = new Map<string, bigint>();
	try {
		for (const amount of amounts) {
			if (typeof amount.unit !== 'string' || typeof amount.quantity !== 'string' || !/^\d+$/.test(amount.quantity)) {
				return null;
			}
			const unit = canonicalHydraUnit(amount.unit);
			const quantity = BigInt(amount.quantity);
			normalized.set(unit, (normalized.get(unit) ?? 0n) + quantity);
		}
		return [...normalized.entries()]
			.filter(([, quantity]) => quantity !== 0n)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([unit, quantity]) => ({ unit, quantity: quantity.toString() }));
	} catch {
		return null;
	}
}

function normalizeHydraAmounts(amounts: readonly HydraAmount[]): Map<string, bigint> | null {
	const canonical = canonicalizeHydraAmounts(amounts);
	return canonical == null ? null : new Map(canonical.map(({ unit, quantity }) => [unit, BigInt(quantity)]));
}

export function hydraAmountListsEqual(left: readonly HydraAmount[], right: readonly HydraAmount[]): boolean {
	const normalizedLeft = normalizeHydraAmounts(left);
	const normalizedRight = normalizeHydraAmounts(right);
	if (!normalizedLeft || !normalizedRight || normalizedLeft.size !== normalizedRight.size) return false;
	for (const [unit, quantity] of normalizedLeft) {
		if (normalizedRight.get(unit) !== quantity) return false;
	}
	return true;
}

/** True when `actual` contains at least the required quantity of every asset. */
export function hydraAmountListCovers(actual: readonly HydraAmount[], required: readonly HydraAmount[]): boolean {
	const normalizedActual = normalizeHydraAmounts(actual);
	const normalizedRequired = normalizeHydraAmounts(required);
	if (!normalizedActual || !normalizedRequired) return false;
	for (const [unit, quantity] of normalizedRequired) {
		if ((normalizedActual.get(unit) ?? 0n) < quantity) return false;
	}
	return true;
}

export function observedHydraOutputMatchesEvidence(
	evidence: HydraTransactionEvidence,
	observed: {
		input: { txHash: string; outputIndex: number };
		output: { address: string; amount: readonly HydraAmount[]; plutusData?: string | null };
	},
): boolean {
	if (observed.input.txHash !== evidence.txHash) return false;
	const evidencedOutput = evidence.outputs.find((output) => output.outputIndex === observed.input.outputIndex);
	return (
		evidencedOutput != null &&
		evidencedOutput.address === observed.output.address &&
		evidencedOutput.plutusData === (observed.output.plutusData ?? null) &&
		hydraAmountListsEqual(evidencedOutput.amount, observed.output.amount)
	);
}

/**
 * Convert signed `invalid_hereafter` to the unix-ms end of that slot using the
 * exact timeline of the L1 chain backing the head. Returning null is fail-closed
 * for a missing bound, malformed slot config, or a pre-genesis slot.
 */
export function hydraValidityUpperBoundTimeMs(
	evidence: Pick<HydraTransactionEvidence, 'validityUpperSlot'>,
	slotConfig: SlotConfig | null,
): bigint | null {
	const slot = evidence.validityUpperSlot;
	if (slot == null || slotConfig == null || slot < 0n) return null;
	const { zeroTime, zeroSlot, slotLength } = slotConfig;
	if (
		!Number.isSafeInteger(zeroTime) ||
		zeroTime < 0 ||
		!Number.isSafeInteger(zeroSlot) ||
		zeroSlot < 0 ||
		!Number.isSafeInteger(slotLength) ||
		slotLength <= 0
	) {
		return null;
	}
	const zeroSlotBigInt = BigInt(zeroSlot);
	if (slot < zeroSlotBigInt) return null;
	return BigInt(zeroTime) + (slot + 1n - zeroSlotBigInt) * BigInt(slotLength);
}

/** Convert the signed lower-validity slot to its unix-ms slot start. */
export function hydraValidityLowerBoundTimeMs(
	evidence: Pick<HydraTransactionEvidence, 'validityLowerSlot'>,
	slotConfig: SlotConfig | null,
): bigint | null {
	const slot = evidence.validityLowerSlot;
	if (slot == null || slotConfig == null || slot < 0n) return null;
	const { zeroTime, zeroSlot, slotLength } = slotConfig;
	if (
		!Number.isSafeInteger(zeroTime) ||
		zeroTime < 0 ||
		!Number.isSafeInteger(zeroSlot) ||
		zeroSlot < 0 ||
		!Number.isSafeInteger(slotLength) ||
		slotLength <= 0
	) {
		return null;
	}
	const zeroSlotBigInt = BigInt(zeroSlot);
	if (slot < zeroSlotBigInt) return null;
	return BigInt(zeroTime) + (slot - zeroSlotBigInt) * BigInt(slotLength);
}

/** Parse immutable input/redeemer evidence from a snapshot-confirmed transaction. */
export function parseHydraTransactionEvidence(cborHex: string): HydraTransactionEvidence | null {
	try {
		if (!/^(?:[0-9a-fA-F]{2})+$/.test(cborHex)) return null;
		const transaction = FixedTransaction.from_bytes(Buffer.from(cborHex, 'hex'));
		if (!transaction.is_valid()) return null;
		const transactionHash = transaction.transaction_hash();
		const txHash = transactionHash.to_hex();
		const transactionHashBytes = transactionHash.to_bytes();
		const transactionBody = transaction.body();
		const validityLowerSlotValue = transactionBody.validity_start_interval_bignum();
		const validityLowerSlot = validityLowerSlotValue == null ? null : BigInt(validityLowerSlotValue.to_str());
		const validityUpperSlotValue = transactionBody.ttl_bignum();
		const validityUpperSlot = validityUpperSlotValue == null ? null : BigInt(validityUpperSlotValue.to_str());
		const bodyInputs = transactionBody.inputs();
		const inputs: HydraInputReference[] = [];
		for (let bodyIndex = 0; bodyIndex < bodyInputs.len(); bodyIndex++) {
			const input = bodyInputs.get(bodyIndex);
			inputs.push({
				txHash: Buffer.from(input.transaction_id().to_bytes()).toString('hex'),
				outputIndex: input.index(),
				bodyIndex,
			});
		}

		const witnessSet = transaction.witness_set();
		const bodyOutputs = transactionBody.outputs();
		const outputs: HydraOutputEvidence[] = [];
		for (let outputIndex = 0; outputIndex < bodyOutputs.len(); outputIndex++) {
			const output = bodyOutputs.get(outputIndex);
			const value = output.amount();
			const amount: HydraOutputEvidence['amount'] = [{ unit: 'lovelace', quantity: value.coin().to_str() }];
			const multiAsset = value.multiasset();
			if (multiAsset) {
				const policyIds = multiAsset.keys();
				for (let policyIndex = 0; policyIndex < policyIds.len(); policyIndex++) {
					const policyId = policyIds.get(policyIndex);
					const assets = multiAsset.get(policyId);
					if (!assets) continue;
					const assetNames = assets.keys();
					for (let assetIndex = 0; assetIndex < assetNames.len(); assetIndex++) {
						const assetName = assetNames.get(assetIndex);
						const quantity = assets.get(assetName);
						if (!quantity) continue;
						amount.push({
							unit: `${policyId.to_hex()}${assetName.to_hex()}`,
							quantity: quantity.to_str(),
						});
					}
				}
			}
			const plutusData = output.plutus_data();
			outputs.push({
				outputIndex,
				address: output.address().to_bech32(),
				amount,
				plutusData: plutusData ? Buffer.from(plutusData.to_bytes()).toString('hex') : null,
			});
		}

		const signerVkeys: string[] = [];
		const vkeyWitnesses = witnessSet.vkeys();
		if (vkeyWitnesses) {
			for (let index = 0; index < vkeyWitnesses.len(); index++) {
				const witness = vkeyWitnesses.get(index);
				const publicKey = witness.vkey().public_key();
				if (!publicKey.verify(transactionHashBytes, witness.signature())) return null;
				signerVkeys.push(Buffer.from(publicKey.hash().to_bytes()).toString('hex'));
			}
		}
		const requiredSignerVkeys: string[] = [];
		const requiredSigners = transactionBody.required_signers();
		if (requiredSigners) {
			for (let index = 0; index < requiredSigners.len(); index++) {
				requiredSignerVkeys.push(Buffer.from(requiredSigners.get(index).to_bytes()).toString('hex'));
			}
		}

		const spends: HydraSpendEvidence[] = [];
		const redeemers = witnessSet.redeemers();
		if (redeemers) {
			// Ledger redeemer pointers index the CANONICALLY ORDERED input set
			// (lexicographic tx-id bytes, then numeric index), not the CBOR
			// serialization order. A peer-crafted body serialized unsorted would
			// otherwise misattribute redeemerVersion (and e.g. miss the disputed-
			// withdrawal parking), wedging replay on the unrecognized spend.
			const canonicalInputs = inputs
				.slice()
				.sort((a, b) => (a.txHash === b.txHash ? a.outputIndex - b.outputIndex : a.txHash < b.txHash ? -1 : 1));
			for (let index = 0; index < redeemers.len(); index++) {
				const redeemer = redeemers.get(index);
				if (redeemer.tag().kind() !== RedeemerTagKind.Spend) continue;
				const bodyIndex = Number(redeemer.index().to_str());
				const input = canonicalInputs[bodyIndex];
				if (!input) continue;
				const decoded = JSON.parse(redeemer.data().to_json(PlutusDatumSchema.BasicConversions)) as {
					constructor?: unknown;
				};
				if (typeof decoded.constructor !== 'number') continue;
				spends.push({ ...input, redeemerVersion: decoded.constructor });
			}
		}

		return {
			txHash,
			validityLowerSlot,
			validityUpperSlot,
			inputs,
			spends,
			outputs,
			signerVkeys,
			requiredSignerVkeys,
		};
	} catch {
		return null;
	}
}

/** Require the immutable signed upper-validity slot used by durable L2 reservations. */
export function requireHydraValidityUpperSlot(cborHex: string): bigint {
	const evidence = parseHydraTransactionEvidence(cborHex);
	if (evidence?.validityUpperSlot == null || evidence.validityUpperSlot < 0n) {
		throw new Error('L2 submission requires a valid signed invalid_hereafter slot');
	}
	return evidence.validityUpperSlot;
}
