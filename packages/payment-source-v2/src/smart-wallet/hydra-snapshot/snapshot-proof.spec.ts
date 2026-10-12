import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from '@jest/globals';
import {
	computeHydraAccumulatorHash,
	computeHydraMembershipWitness,
	hydraAccumulatorHashOfCommitment,
} from '@/lib/hydra/hydra/snapshot-accumulator';
import { verifyHydraMembership } from '@/lib/hydra/hydra/snapshot-membership';
import { hydraSnapshotSignableBytes } from '@/lib/hydra/hydra/snapshot-verification';
import { hydraSnapshotProofSchema } from '../cosign-client';
import { toHydraSnapshotProof } from './build-proof';
import {
	serializeSnapshotTxOut,
	verifyHydraSnapshotProof,
	type HydraSnapshotProof,
	type SnapshotTxOut,
	type SnapshotUTxO,
} from './snapshot-proof';
import fixture from './__fixtures__/preprod-snapshot.json';
import pendingFixture from './__fixtures__/preprod-snapshot-pending-commit.json';

// Real confirmed snapshots from a preprod head (hydra-node 2.4.1), signed by both parties.
// Snapshot 10: the guarded wallet is leaving the head (`utxoToDecommit`).
// Snapshot 12: the wallet was deposited again and is still only in `utxoToCommit`.
const HEAD_ID = '141b98198372df5b674a159c26ef5e157b5d590e5b661502c99e0478';
const PARTY_KEYS = fixture.partyKeysFromL1OpenDatum;
const STATE_TOKEN_UNIT =
	'98e2d2cf925964efa78edb7af0978d49db3f81e58c5d6b1c66673836' +
	'cb02c3c8aa1e19b6a986b95465ce3b18b47929e440a3a50bccf67c3fe54c6d9b';
const ESCROW_REF = '07a2a64855430fc96da3b2b40265fb393ffd4e601d23d030c7c7cb792029b9c0#1';
const DECOMMITTED_WALLET_REF = '1ff0ae1bb9621cf02aebaad73f26c094f0364a5845266aaca971c137deda2d70#0';
const DEPOSITED_WALLET_REF = '7659f93523613feeeedd8007dd14fef61e651f92b606cb464a028f5e5a1616c4#1';

type RawConfirmed = { snapshot: { utxo: Record<string, Record<string, unknown>> } };
const rawPending = () => structuredClone(pendingFixture.confirmedSnapshot) as unknown as RawConfirmed;
const pending = (ref = DEPOSITED_WALLET_REF): HydraSnapshotProof => toHydraSnapshotProof(rawPending(), ref);
const check = (
	candidate: HydraSnapshotProof,
	overrides: { partyKeys?: string[]; headId?: string; unit?: string } = {},
) =>
	verifyHydraSnapshotProof({
		proof: candidate,
		headId: overrides.headId ?? HEAD_ID,
		partyKeys: overrides.partyKeys ?? PARTY_KEYS,
		stateTokenUnit: overrides.unit ?? STATE_TOKEN_UNIT,
	});

describe('verifyHydraSnapshotProof on preprod snapshots', () => {
	it('accepts the wallet output with a witness against the real signed accumulator', () => {
		const output = check(pending());
		expect(output.address).toBe(
			'addr_test1zzvw95k0jfvkfma83mdh4uyh34yak0upukx966cuvennsd3ylyqmd4rq6dt35f8a9l9hugzc9ux5lmcm9s7umqzk8qaq2dgjdy',
		);
		expect(output.value.lovelace).toBe('85000000');
	});

	it('sends the head as two points, not as its UTxO set', () => {
		const proof = pending();
		expect(proof).not.toHaveProperty('utxo');
		expect(proof.commitment).toMatch(/^[0-9a-f]{96}$/);
		expect(proof.witness).toMatch(/^[0-9a-f]{96}$/);
	});

	it('rejects a changed wallet output, a witness for another output and another commitment', () => {
		const changed = pending();
		changed.walletOutput.value.lovelace = '185000000';
		expect(() => check(changed)).toThrow('does not prove');
		// A real witness for the escrow output does not prove the wallet output.
		const swapped = { ...pending(), witness: pending(ESCROW_REF).witness };
		expect(() => check(swapped)).toThrow('does not prove');
		const leavingProof = toHydraSnapshotProof(structuredClone(fixture.confirmedSnapshot), ESCROW_REF);
		expect(() => check({ ...pending(), commitment: leavingProof.commitment })).toThrow(
			'does not hash to the signed accumulator',
		);
	});

	it('rejects points that are not on the curve', () => {
		expect(() => check({ ...pending(), witness: 'ff'.repeat(48) })).toThrow('not a valid G1 point');
	});

	it('rejects a changed commit set and another deposit transaction id', () => {
		const committed = pending();
		const wallet = committed.utxoToCommit?.[DEPOSITED_WALLET_REF];
		if (wallet == null) throw new Error('fixture has no pending deposit');
		wallet.value.lovelace = '185000000';
		expect(() => check(committed)).toThrow('signature 0 was invalid');
		expect(() => check({ ...pending(), depositTxId: 'ee'.repeat(32) })).toThrow('signature 0 was invalid');
	});

	it('rejects signatures in the wrong party order, wrong or missing keys and another head', () => {
		const reversed = pending();
		reversed.signatures.reverse();
		expect(() => check(reversed)).toThrow('signature 0 was invalid');
		expect(() => check(pending(), { partyKeys: [PARTY_KEYS[0], 'aa'.repeat(32)] })).toThrow('signature 1 was invalid');
		expect(() => check(pending(), { partyKeys: [PARTY_KEYS[0]] })).toThrow('signature count');
		expect(() => check({ ...pending(), signatures: [] }, { partyKeys: [] })).toThrow('signature count');
		expect(() => check(pending(), { headId: 'aa'.repeat(28) })).toThrow('another head');
	});

	it('rejects an output that does not hold the wallet state token', () => {
		expect(() => check(pending(ESCROW_REF))).toThrow('does not hold the wallet state token');
	});

	it('does not build a proof for a wallet that is only on its way out of the head', () => {
		expect(() => toHydraSnapshotProof(structuredClone(fixture.confirmedSnapshot), DECOMMITTED_WALLET_REF)).toThrow(
			'does not hold the guarded wallet',
		);
	});

	it('refuses a state token unit with no asset name', () => {
		expect(() => check(pending(), { unit: STATE_TOKEN_UNIT.slice(0, 56) })).toThrow('Invalid state token unit');
	});

	it('refuses a quantity with a leading zero, so one amount has one spelling', () => {
		const candidate = pending();
		candidate.walletOutput.value.lovelace = '085000000';
		expect(() => check(candidate)).toThrow('Invalid quantity');
	});
});

// Snapshots signed here with fresh keys, for cases no preprod snapshot shows.
describe('verifyHydraSnapshotProof on locally signed snapshots', () => {
	const parties = [generateKeyPairSync('ed25519'), generateKeyPairSync('ed25519')];
	const partyKeys = parties.map(({ publicKey }) =>
		publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex'),
	);
	const walletOutput = pending().walletOutput;
	const escrowOutput = pending(ESCROW_REF).walletOutput;
	const policy = STATE_TOKEN_UNIT.slice(0, 56);
	const name = STATE_TOKEN_UNIT.slice(56);

	/** Sign a snapshot over `utxo` and `utxoToDecommit`, with a witness for `member`. */
	const signed = (utxo: SnapshotUTxO, member: SnapshotTxOut, utxoToDecommit: SnapshotUTxO | null = null) => {
		const outputs = [...Object.values(utxo), ...Object.values(utxoToDecommit ?? {})].map(serializeSnapshotTxOut);
		const { commitment, witness } = computeHydraMembershipWitness(outputs, serializeSnapshotTxOut(member));
		const header = {
			headId: HEAD_ID,
			version: 1,
			number: 3,
			accumulator: computeHydraAccumulatorHash(outputs),
			utxoToCommit: null,
			utxoToDecommit,
			depositTxId: null,
		};
		const message = hydraSnapshotSignableBytes({
			headId: HEAD_ID,
			signatures: { multiSignature: [] },
			snapshot: {
				...header,
				confirmed: [],
				utxo: {},
				utxoToDecommit: utxoToDecommit == null ? null : decommitFrame(utxoToDecommit),
			},
		});
		const proof: HydraSnapshotProof = {
			...header,
			commitment,
			witness,
			walletOutput: member,
			signatures: parties.map(({ privateKey }) => sign(null, message, privateKey).toString('hex')),
		};
		return proof;
	};
	// The frame form of a pending set, as the verifier builds it.
	const decommitFrame = (set: SnapshotUTxO) =>
		Object.fromEntries(
			Object.entries(set).map(([ref, out]) => [
				ref,
				{
					address: out.address,
					value: Object.fromEntries(
						Object.entries(out.value).map(([key, entry]) => [
							key,
							typeof entry === 'string'
								? BigInt(entry)
								: Object.fromEntries(Object.entries(entry).map(([n, q]) => [n, BigInt(q)])),
						]),
					),
					referenceScript: null,
					datumhash: out.datumhash ?? null,
					inlineDatumhash: null,
					inlineDatum: null,
					inlineDatumRaw: out.inlineDatumRaw ?? null,
					datum: null,
				},
			]),
		);
	const verify = (candidate: HydraSnapshotProof) =>
		verifyHydraSnapshotProof({ proof: candidate, headId: HEAD_ID, partyKeys, stateTokenUnit: STATE_TOKEN_UNIT });
	const walletRef = `${'aa'.repeat(32)}#1`;
	const escrowRef = `${'bb'.repeat(32)}#0`;

	it('accepts the wallet output from the head UTxO set', () => {
		expect(verify(signed({ [walletRef]: walletOutput, [escrowRef]: escrowOutput }, walletOutput))).toEqual(
			walletOutput,
		);
	});

	it('refuses a wallet whose state token is in the signed decommit set', () => {
		// The witness is real: the accumulator covers the decommit set too.
		const proof = signed({ [escrowRef]: escrowOutput }, walletOutput, { [walletRef]: walletOutput });
		expect(() => verify(proof)).toThrow('on its way out');
	});

	it('only counts a state token held with quantity 1', () => {
		const two = { ...walletOutput, value: { ...walletOutput.value, [policy]: { [name]: '2' } } };
		expect(() => verify(signed({ [walletRef]: two }, two))).toThrow('does not hold the wallet state token');
	});

	it('refuses value keys that differ from the signed spelling', () => {
		// The serializer lowercases keys, so an uppercase twin would sign as one key.
		const proof = signed({ [walletRef]: walletOutput }, walletOutput);
		const forged = {
			...walletOutput,
			value: {
				...walletOutput.value,
				[policy]: { cafe: '1000000' },
				[policy.toUpperCase()]: walletOutput.value[policy],
			},
		};
		expect(() => verify({ ...proof, walletOutput: forged })).toThrow('Invalid policy');
		const prototype = JSON.parse(
			`{"address":"${walletOutput.address}","value":{"lovelace":"1","__proto__":{}}}`,
		) as SnapshotTxOut;
		expect(() => verify({ ...proof, walletOutput: prototype })).toThrow('Invalid policy');
	});

	it('returns the signed canonical datum bytes, not the bytes sent', () => {
		const proof = signed({ [walletRef]: walletOutput }, walletOutput);
		const padded = { ...walletOutput, inlineDatumRaw: `${walletOutput.inlineDatumRaw}ff` };
		expect(verify({ ...proof, walletOutput: padded }).inlineDatumRaw).toBe(walletOutput.inlineDatumRaw);
	});

	it('returns a fresh output with only the signed fields', () => {
		const proof = signed({ [walletRef]: walletOutput }, walletOutput);
		const withExtra = { ...walletOutput, referenceScript: { script: 'x' } } as SnapshotTxOut;
		const output = verify({ ...proof, walletOutput: withExtra });
		expect(Object.keys(output).sort()).toEqual(['address', 'datumhash', 'inlineDatumRaw', 'value']);
	});
});

describe('toHydraSnapshotProof and the wire schema', () => {
	it('turns bigint quantities into exact decimal strings', () => {
		const raw = rawPending() as unknown as { snapshot: { utxoToCommit: Record<string, { value: object }> } };
		raw.snapshot.utxoToCommit[DEPOSITED_WALLET_REF].value = {
			...raw.snapshot.utxoToCommit[DEPOSITED_WALLET_REF].value,
			lovelace: 18446744073709551615n,
		};
		expect(toHydraSnapshotProof(raw, DEPOSITED_WALLET_REF).walletOutput.value.lovelace).toBe('18446744073709551615');
	});

	it('builds a proof when another output in the head carries a reference script', () => {
		const raw = rawPending();
		raw.snapshot.utxo[ESCROW_REF].referenceScript = {
			scriptLanguage: 'SimpleScript',
			script: { cborHex: `8200581c${'aa'.repeat(28)}`, description: '', type: 'SimpleScript' },
		};
		const proof = toHydraSnapshotProof(raw, DEPOSITED_WALLET_REF);
		expect(() =>
			verifyHydraMembership({
				accumulator: hydraAccumulatorHashOfCommitment(Buffer.from(proof.commitment, 'hex')),
				commitment: proof.commitment,
				witness: proof.witness,
				serializedOutput: serializeSnapshotTxOut(proof.walletOutput),
			}),
		).not.toThrow();
		// The script changes the head's commitment, so the old signed accumulator no longer matches.
		expect(proof.commitment).not.toBe(pending().commitment);
	});

	it('accepts the preprod proof and refuses non-canonical fields', () => {
		expect(hydraSnapshotProofSchema.safeParse(pending()).success).toBe(true);
		const leadingZero = pending();
		leadingZero.walletOutput.value.lovelace = '085000000';
		expect(hydraSnapshotProofSchema.safeParse(leadingZero).success).toBe(false);
		expect(hydraSnapshotProofSchema.safeParse({ ...pending(), accumulator: 'AC'.repeat(32) }).success).toBe(false);
		expect(hydraSnapshotProofSchema.safeParse({ ...pending(), witness: 'ab'.repeat(47) }).success).toBe(false);
		const upperKey = pending();
		upperKey.walletOutput.value = { lovelace: '1', ['AB'.repeat(28)]: { '': '1' } };
		expect(hydraSnapshotProofSchema.safeParse(upperKey).success).toBe(false);
	});
});
