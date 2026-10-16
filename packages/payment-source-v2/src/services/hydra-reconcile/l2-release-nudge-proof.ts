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
 * The nudge avoids references. It spends the reservation's own wallet inputs
 * into one output back to the wallet, tagged with a random 32-byte nonce as an
 * inline datum. Those bytes exist nowhere else, so finding them in a verified
 * snapshot shows that our nudge applied. A body applies at most once per input,
 * so the reservation's body can then never apply. If the body applied first,
 * its inputs are gone, the head rejects the nudge, and the bytes never appear.
 *
 * Anyone with in-head funds can create an output with the same bytes once they
 * see the nonce. Doing so pays our wallet the full value of the inputs the
 * reservation's body spends, which is at least what a false release could
 * redirect. Within one head only the counterparty holds such funds.
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

/**
 * What to look for, from the signed nudge `nudgeTx`. Null unless it is a
 * nudge for this reservation: at least one input, every input one the body
 * spends, and exactly one output carrying a nonce datum.
 */
export function readL2ReleaseNudgeProof(
	nudgeTx: string,
	reservationInputRefs: readonly string[],
): L2ReleaseNudgeProof | null {
	const shape = readHydraSignedTransactionShape(nudgeTx);
	if (!shape || shape.inputRefs.length === 0 || shape.outputs.length !== 1) return null;
	const reserved = new Set(reservationInputRefs.map((reference) => reference.toLowerCase()));
	if (!shape.inputRefs.every((reference) => reserved.has(reference))) return null;
	const [output] = shape.outputs;
	if (output.inlineDatumHex === null || !NUDGE_DATUM_PATTERN.test(output.inlineDatumHex.toLowerCase())) return null;
	return { reference: output.reference, serializedOutput: output.serializedOutput };
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
	readOutput: (reference: string) => string | null;
}): boolean {
	if (params.nudgeTx === null) return false;
	const proof = readL2ReleaseNudgeProof(params.nudgeTx, params.inputRefs);
	return proof !== null && params.readOutput(proof.reference) === proof.serializedOutput;
}
