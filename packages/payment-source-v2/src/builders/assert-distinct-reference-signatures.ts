// Guards a fabricated-collision griefing vector: an attacker locks two UTxOs
// with IDENTICAL datum `reference_signature` bytes. The validator enforces
// `list.unique(input_datum_signatures)` (vested_pay.ak:191) and fails phase-2,
// burning the operator's collateral. The `(txHash, outputIndex)` dedupe in
// batch-interaction.ts misses it (each fabricated UTxO has its own ref).
//
// Standalone module (not inlined in batch-interaction.ts) so the test can
// import it without pulling the builder's transitive @masumi/payment-core
// graph through Jest's resolver.
import { deserializeDatum, type UTxO } from '@meshsdk/core';

/**
 * Extract `reference_signature` (V2 datum field index 5) from a script UTxO's
 * inline datum. Returns `null` when the datum is missing, malformed, or does
 * not match the V2 layout — those items will fail at a downstream validation
 * step anyway (datum-decode in the service layer or contract phase-1).
 */
export function extractReferenceSignatureFromUtxo(utxo: UTxO): string | null {
	const plutusData = utxo.output.plutusData;
	if (plutusData == null) return null;
	let decoded: unknown;
	try {
		decoded = deserializeDatum(plutusData);
	} catch {
		return null;
	}
	if (
		decoded == null ||
		typeof decoded !== 'object' ||
		!('fields' in decoded) ||
		!Array.isArray((decoded as { fields: unknown }).fields)
	) {
		return null;
	}
	const fields = (decoded as { fields: Array<{ bytes?: unknown }> }).fields;
	const referenceSignature = fields[5]?.bytes;
	return typeof referenceSignature === 'string' ? referenceSignature : null;
}

function refKey(utxo: UTxO): string {
	return `${utxo.input.txHash}#${utxo.input.outputIndex}`;
}

/**
 * Decode each item's datum and assert reference_signature uniqueness across
 * the batch. Items whose datum cannot be parsed are skipped — those fail at
 * the V2 service-layer validation before reaching here, but the skip keeps
 * the helper non-fatal if a future caller routes a malformed item through.
 */
export function assertDistinctReferenceSignatures<T extends { smartContractUtxo: UTxO }>(items: T[]): void {
	const seen = new Map<string, string>();
	for (const item of items) {
		const referenceSignature = extractReferenceSignatureFromUtxo(item.smartContractUtxo);
		if (referenceSignature == null) continue;
		const refKeyForItem = refKey(item.smartContractUtxo);
		const previousRefKey = seen.get(referenceSignature);
		if (previousRefKey != null) {
			throw new Error(
				`Duplicate reference_signature ${referenceSignature} in batch — ` +
					`UTxOs ${previousRefKey} and ${refKeyForItem} share the same datum ` +
					`reference_signature; contract dedupe would reject this in phase-2`,
			);
		}
		seen.set(referenceSignature, refKeyForItem);
	}
}
