import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from '@jest/globals';
import { computeHydraAccumulatorHash, hydraSnapshotSignableBytes } from '@/lib/hydra/hydra/snapshot-verification';
import { serializeHydraSnapshotOutput } from '@/lib/hydra/hydra/snapshot-serialization';
import { hydraSnapshotProofSchema } from '../cosign-client';
import { toHydraSnapshotProof } from './build-proof';
import {
	toVerificationFrame,
	verifyHydraSnapshotProof,
	type HydraSnapshotProof,
	type SnapshotTxOut,
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

const leaving = (): HydraSnapshotProof => toHydraSnapshotProof(structuredClone(fixture.confirmedSnapshot));
const pending = (): HydraSnapshotProof => toHydraSnapshotProof(structuredClone(pendingFixture.confirmedSnapshot));
const check = (
	candidate: HydraSnapshotProof,
	overrides: { partyKeys?: string[]; ref?: string; headId?: string; unit?: string } = {},
) =>
	verifyHydraSnapshotProof({
		proof: candidate,
		headId: overrides.headId ?? HEAD_ID,
		partyKeys: overrides.partyKeys ?? PARTY_KEYS,
		stateTokenUnit: overrides.unit ?? STATE_TOKEN_UNIT,
		walletUtxoRef: overrides.ref ?? DEPOSITED_WALLET_REF,
	});

describe('verifyHydraSnapshotProof on preprod snapshots', () => {
	it('accepts the wallet output from the signed commit set', () => {
		const output = check(pending());
		expect(output.address).toBe(
			'addr_test1zzvw95k0jfvkfma83mdh4uyh34yak0upukx966cuvennsd3ylyqmd4rq6dt35f8a9l9hugzc9ux5lmcm9s7umqzk8qaq2dgjdy',
		);
		expect(output.value.lovelace).toBe('85000000');
	});

	it('rejects a changed output, in the head or in the commit set', () => {
		const inHead = pending();
		inHead.utxo[ESCROW_REF].value.lovelace = '999000000';
		expect(() => check(inHead)).toThrow('accumulator did not match');
		const committed = pending();
		const wallet = committed.utxoToCommit?.[DEPOSITED_WALLET_REF];
		if (wallet == null) throw new Error('fixture has no pending deposit');
		wallet.value.lovelace = '185000000';
		expect(() => check(committed)).toThrow('signature 0 was invalid');
	});

	it('rejects an added output and another deposit transaction id', () => {
		const added = pending();
		added.utxo[`${'ee'.repeat(32)}#0`] = added.utxo[ESCROW_REF];
		expect(() => check(added)).toThrow('accumulator did not match');
		const otherDeposit = pending();
		otherDeposit.depositTxId = 'ee'.repeat(32);
		expect(() => check(otherDeposit)).toThrow('signature 0 was invalid');
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

	it('does not accept a wallet that is only on its way out of the head', () => {
		expect(() => check(leaving(), { ref: DECOMMITTED_WALLET_REF })).toThrow('exactly once');
	});

	it('rejects a wallet ref that is not where the state token is', () => {
		expect(() => check(pending(), { ref: ESCROW_REF })).toThrow('not at the named output');
	});

	it('refuses a state token unit with no asset name', () => {
		expect(() => check(pending(), { unit: STATE_TOKEN_UNIT.slice(0, 56) })).toThrow('Invalid state token unit');
	});

	it('refuses a quantity with a leading zero, so one amount has one spelling', () => {
		const candidate = pending();
		candidate.utxo[ESCROW_REF].value.lovelace = '05000000';
		expect(() => check(candidate)).toThrow('Invalid quantity');
	});
});

// Snapshots signed here with fresh keys, for cases no preprod snapshot shows.
describe('verifyHydraSnapshotProof on locally signed snapshots', () => {
	const parties = [generateKeyPairSync('ed25519'), generateKeyPairSync('ed25519')];
	const partyKeys = parties.map(({ publicKey }) =>
		publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex'),
	);
	const walletOutput = pending().utxoToCommit?.[DEPOSITED_WALLET_REF] as SnapshotTxOut;
	const escrowOutput = pending().utxo[ESCROW_REF];
	const walletRef = `${'aa'.repeat(32)}#1`;
	const escrowRef = `${'bb'.repeat(32)}#0`;

	const signed = (utxo: HydraSnapshotProof['utxo']): HydraSnapshotProof => {
		const unsigned: HydraSnapshotProof = {
			headId: HEAD_ID,
			version: 1,
			number: 3,
			accumulator: '',
			utxo,
			utxoToCommit: null,
			utxoToDecommit: null,
			depositTxId: null,
			signatures: [],
		};
		const frame = toVerificationFrame(unsigned);
		unsigned.accumulator = computeHydraAccumulatorHash(
			Object.values(frame.snapshot.utxo).map(serializeHydraSnapshotOutput),
		);
		const message = hydraSnapshotSignableBytes(toVerificationFrame(unsigned));
		return {
			...unsigned,
			signatures: parties.map(({ privateKey }) => sign(null, message, privateKey).toString('hex')),
		};
	};
	const verify = (candidate: HydraSnapshotProof, ref: string) =>
		verifyHydraSnapshotProof({
			proof: candidate,
			headId: HEAD_ID,
			partyKeys,
			stateTokenUnit: STATE_TOKEN_UNIT,
			walletUtxoRef: ref,
		});

	it('accepts the wallet output from the head UTxO set', () => {
		expect(verify(signed({ [walletRef]: walletOutput, [escrowRef]: escrowOutput }), walletRef)).toEqual(walletOutput);
	});

	it('does not let a sender relabel outputs, because refs are not signed', () => {
		// Same signed contents, refs swapped: the signatures and accumulator still hold.
		const swapped = signed({ [walletRef]: walletOutput, [escrowRef]: escrowOutput });
		swapped.utxo = { [walletRef]: escrowOutput, [escrowRef]: walletOutput };
		expect(() => verify(swapped, walletRef)).toThrow('not at the named output');
		expect(verify(swapped, escrowRef)).toEqual(walletOutput);
	});

	it('refuses a set where the state token appears twice', () => {
		expect(() => verify(signed({ [walletRef]: walletOutput, [escrowRef]: walletOutput }), walletRef)).toThrow(
			'exactly once',
		);
	});

	it('only counts a state token held with quantity 1', () => {
		const policy = STATE_TOKEN_UNIT.slice(0, 56);
		const name = STATE_TOKEN_UNIT.slice(56);
		const two = { ...walletOutput, value: { ...walletOutput.value, [policy]: { [name]: '2' } } };
		expect(() => verify(signed({ [walletRef]: two }), walletRef)).toThrow('exactly once');
	});

	it('refuses value keys that differ from the signed spelling', () => {
		// The serializer lowercases keys, so an uppercase twin would sign as one key.
		const policy = STATE_TOKEN_UNIT.slice(0, 56);
		const forged = {
			...walletOutput,
			value: {
				...walletOutput.value,
				[policy]: { cafe: '1000000' },
				[policy.toUpperCase()]: walletOutput.value[policy],
			},
		};
		expect(() => verify(signed({ [walletRef]: walletOutput }), walletRef)).not.toThrow();
		const proof = signed({ [walletRef]: walletOutput });
		proof.utxo = { [walletRef]: forged };
		expect(() => verify(proof, walletRef)).toThrow('Invalid policy');
		proof.utxo = {
			[walletRef]: JSON.parse(`{"address":"${walletOutput.address}","value":{"lovelace":"1","__proto__":{}}}`),
		};
		expect(() => verify(proof, walletRef)).toThrow('Invalid policy');
	});

	it('returns the signed canonical datum bytes, not the bytes sent', () => {
		const proof = signed({ [walletRef]: walletOutput });
		proof.utxo = { [walletRef]: { ...walletOutput, inlineDatumRaw: `${walletOutput.inlineDatumRaw}ff` } };
		expect(verify(proof, walletRef).inlineDatumRaw).toBe(walletOutput.inlineDatumRaw);
	});

	it('returns a fresh output with only the signed fields', () => {
		const withExtra = { ...walletOutput, referenceScript: { script: 'x' } } as SnapshotTxOut;
		const output = verify(signed({ [walletRef]: withExtra }), walletRef);
		expect(Object.keys(output).sort()).toEqual(['address', 'datumhash', 'inlineDatumRaw', 'value']);
	});

	it('refuses refs that are not in canonical form', () => {
		const proof = signed({ [walletRef]: walletOutput });
		proof.utxo = { [walletRef.toUpperCase()]: walletOutput };
		expect(() => verify(proof, walletRef)).toThrow('Invalid output reference');
		proof.utxo = { [walletRef.replace('#1', '#01')]: walletOutput };
		expect(() => verify(proof, walletRef)).toThrow('Invalid output reference');
	});
});

describe('toHydraSnapshotProof and the wire schema', () => {
	it('turns bigint quantities into exact decimal strings', () => {
		const raw = structuredClone(pendingFixture.confirmedSnapshot) as { snapshot: { utxo: Record<string, unknown> } };
		raw.snapshot.utxo[ESCROW_REF] = { address: 'addr_test', value: { lovelace: 18446744073709551615n } };
		expect(toHydraSnapshotProof(raw).utxo[ESCROW_REF].value.lovelace).toBe('18446744073709551615');
	});

	it('accepts both preprod proofs and refuses non-canonical quantities and refs', () => {
		expect(hydraSnapshotProofSchema.safeParse(pending()).success).toBe(true);
		expect(hydraSnapshotProofSchema.safeParse(leaving()).success).toBe(true);
		const leadingZero = pending();
		leadingZero.utxo[ESCROW_REF].value.lovelace = '05000000';
		expect(hydraSnapshotProofSchema.safeParse(leadingZero).success).toBe(false);
		expect(hydraSnapshotProofSchema.safeParse({ ...pending(), accumulator: 'AC'.repeat(32) }).success).toBe(false);
		const upperKey = pending();
		upperKey.utxo[ESCROW_REF].value = { lovelace: '1', ['AB'.repeat(28)]: { '': '1' } };
		expect(hydraSnapshotProofSchema.safeParse(upperKey).success).toBe(false);
		const paddedRef = pending();
		paddedRef.utxo[ESCROW_REF.replace('#1', '#01')] = paddedRef.utxo[ESCROW_REF];
		expect(hydraSnapshotProofSchema.safeParse(paddedRef).success).toBe(false);
	});
});
