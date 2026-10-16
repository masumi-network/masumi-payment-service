/**
 * Proof that an expired L2 reservation can never apply: our own nudge spent
 * its inputs.
 *
 * Hydra signs the multiset of output VALUES, not `txHash#index` references, so
 * a verified snapshot proves which output bytes exist and nothing about which
 * reference holds them. Reading "this input is still unspent" from a snapshot
 * trusts the local node's reference mapping, and two outputs with equal bytes
 * (5 ADA collateral twins, for one) can stand in for each other.
 *
 * The nudge avoids references. It spends every input of the reservation's
 * body into one output back to the wallet, tagged with a random 32-byte nonce
 * as an inline datum. Those bytes exist nowhere else, so finding them in a
 * verified snapshot shows that our nudge applied. A body applies at most once
 * per input, so the reservation's body can then never apply. If the body
 * applied first, its inputs are gone, the head rejects the nudge, and the
 * bytes never appear.
 *
 * Anyone with in-head funds can create an output with the same bytes once they
 * see the nonce. The node reports the inputs' values, so a compromised node
 * could make those bytes cheap to copy. The value floor stops that: the output
 * must carry at least the funds the reservation's body locks, taken from our
 * own records. Copying the bytes then pays our wallet at least what a false
 * release could redirect. Spending every input, not a subset the node picks,
 * keeps the floor tied to the whole body.
 */

import { readHydraSignedTransactionShape } from '@/lib/hydra/hydra/signed-transaction-shape';

/** `Constr 1 [nonce]`. The terminal-payout check reads `Constr 0 [txHash, index]`, so the shapes never collide. */
const NUDGE_DATUM_PREFIX = 'd87a815820';
const NUDGE_DATUM_PATTERN = new RegExp(`^${NUDGE_DATUM_PREFIX}[0-9a-f]{64}$`);
export const L2_RELEASE_NUDGE_NONCE_BYTES = 32;

export function encodeL2ReleaseNudgeDatum(nonce: Uint8Array): string {
	if (nonce.length !== L2_RELEASE_NUDGE_NONCE_BYTES) throw new Error('A release nudge nonce is exactly 32 bytes');
	return `${NUDGE_DATUM_PREFIX}${Buffer.from(nonce).toString('hex')}`;
}

export type L2ReleaseNudgeProof = {
	/** Where the nudge's output sits once it applies. Used only to look the bytes up. */
	reference: string;
	/** The bytes whose presence in a verified snapshot is the proof. */
	serializedOutput: string;
};

/** Minimum quantity per unit the nudge output must carry. `''` and `lovelace` both mean ADA. */
export type L2ReleaseValueFloor = ReadonlyArray<{ unit: string; amount: bigint }>;

export function normalizeL2ReleaseUnit(unit: string): string {
	return unit === '' || unit.toLowerCase() === 'lovelace' ? 'lovelace' : unit.toLowerCase();
}

/**
 * What to look for, from the signed nudge `nudgeTx`. Null unless it is a
 * nudge for this reservation: it spends exactly the body's inputs, and its one
 * output carries a nonce datum and at least `valueFloor`. An empty floor
 * proves nothing, so it is null too.
 */
export function readL2ReleaseNudgeProof(
	nudgeTx: string,
	reservationInputRefs: readonly string[],
	valueFloor: L2ReleaseValueFloor,
): L2ReleaseNudgeProof | null {
	const shape = readHydraSignedTransactionShape(nudgeTx);
	if (!shape || shape.outputs.length !== 1) return null;
	const reserved = new Set(reservationInputRefs.map((reference) => reference.toLowerCase()));
	const spent = new Set(shape.inputRefs);
	if (reserved.size === 0 || spent.size !== reserved.size || ![...reserved].every((ref) => spent.has(ref))) {
		return null;
	}
	const [output] = shape.outputs;
	if (output.inlineDatumHex === null || !NUDGE_DATUM_PATTERN.test(output.inlineDatumHex.toLowerCase())) return null;
	if (!meetsValueFloor(output.value, valueFloor)) return null;
	return { reference: output.reference, serializedOutput: output.serializedOutput };
}

function meetsValueFloor(value: ReadonlyMap<string, bigint>, valueFloor: L2ReleaseValueFloor): boolean {
	const required = new Map<string, bigint>();
	for (const { unit, amount } of valueFloor) {
		const key = normalizeL2ReleaseUnit(unit);
		required.set(key, (required.get(key) ?? 0n) + amount);
	}
	if (![...required.values()].some((amount) => amount > 0n)) return false;
	return [...required].every(([unit, amount]) => (value.get(unit) ?? 0n) >= amount);
}

/**
 * True once the verified snapshot holds the nudge's exact output bytes.
 * `readOutput` returns the bytes the snapshot holds at a reference, or null.
 * A forged reference mapping can only hide the bytes, never invent them: every
 * value it returns is one the signed multiset holds.
 */
export function isL2ReservationSpentByNudge(params: {
	nudgeTx: string | null;
	inputRefs: readonly string[];
	/** Null when the reservation has no floor we can trust; it then stays held. */
	valueFloor: L2ReleaseValueFloor | null;
	readOutput: (reference: string) => string | null;
}): boolean {
	if (params.nudgeTx === null || params.valueFloor === null) return false;
	const proof = readL2ReleaseNudgeProof(params.nudgeTx, params.inputRefs, params.valueFloor);
	return proof !== null && params.readOutput(proof.reference) === proof.serializedOutput;
}
