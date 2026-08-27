import { describe, expect, it } from '@jest/globals';
import { HydraPartyIdentity } from './node-party-identity';
import { deriveHydraVerificationKeyCborHex, hydraVerificationKeyRawHex } from './snapshot-verification';

const LOCAL_SK = `5820${'11'.repeat(32)}`;
const REMOTE_SK = `5820${'22'.repeat(32)}`;
const localVk = deriveHydraVerificationKeyCborHex(LOCAL_SK);
const remoteVk = deriveHydraVerificationKeyCborHex(REMOTE_SK);
const localRaw = hydraVerificationKeyRawHex(localVk);
const remoteRaw = hydraVerificationKeyRawHex(remoteVk);

const noHeadCheck = () => undefined;

describe('HydraPartyIdentity construction', () => {
	it('rejects duplicate configured keys', () => {
		expect(() => new HydraPartyIdentity([localVk, localVk], localVk)).toThrow(/must be unique/);
	});

	it('rejects a local key outside the configured set', () => {
		expect(() => new HydraPartyIdentity([remoteVk], localVk)).toThrow(/must belong to the configured participant set/);
	});
});

describe('HydraPartyIdentity party-order binding', () => {
	it('binds the on-chain order once and refuses a different one', () => {
		const identity = new HydraPartyIdentity([localVk, remoteVk], localVk);
		identity.bindSnapshotPartyOrder(
			{ tag: 'HeadIsInitializing', headId: 'a'.repeat(56), parties: [{ vkey: remoteRaw }, { vkey: localRaw }] },
			noHeadCheck,
		);
		expect(identity.orderedSnapshotVerificationKeys).toEqual([remoteRaw, localRaw]);

		expect(() =>
			identity.bindSnapshotPartyOrder(
				{ tag: 'HeadIsInitializing', headId: 'a'.repeat(56), parties: [{ vkey: localRaw }, { vkey: remoteRaw }] },
				noHeadCheck,
			),
		).toThrow(/order changed within one configured head/);
	});

	it('refuses an on-chain set that is not the configured set', () => {
		const identity = new HydraPartyIdentity([localVk, remoteVk], localVk);
		const strangerRaw = hydraVerificationKeyRawHex(deriveHydraVerificationKeyCborHex(`5820${'33'.repeat(32)}`));
		expect(() =>
			identity.bindSnapshotPartyOrder(
				{ tag: 'HeadIsInitializing', headId: 'a'.repeat(56), parties: [{ vkey: localRaw }, { vkey: strangerRaw }] },
				noHeadCheck,
			),
		).toThrow(/did not match the configured verification keys/);
	});
});

describe('HydraPartyIdentity Greetings verification', () => {
	function greetings(me: string, party: string, others: string[]) {
		return {
			tag: 'Greetings',
			me: { vkey: me },
			env: { party: { vkey: party }, otherParties: others.map((vkey) => ({ vkey })) },
		};
	}

	it('accepts a Greetings that names the configured local key and counterparties', () => {
		const identity = new HydraPartyIdentity([localVk, remoteVk], localVk);
		expect(() => identity.verifyGreetingsPartyIdentity(greetings(localRaw, localRaw, [remoteRaw]))).not.toThrow();
	});

	it('rejects a Greetings whose node identifies as someone else', () => {
		// The check that makes a socket to the WRONG node fail closed instead of
		// silently acting on another participant's view of the head.
		const identity = new HydraPartyIdentity([localVk, remoteVk], localVk);
		expect(() => identity.verifyGreetingsPartyIdentity(greetings(remoteRaw, remoteRaw, [localRaw]))).toThrow(
			/did not identify the configured local signing key/,
		);
	});
});
