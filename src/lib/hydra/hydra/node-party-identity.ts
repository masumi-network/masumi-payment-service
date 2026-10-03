/**
 * The configured participant identity of one head, and the two checks every
 * socket must pass against it: the on-chain party order binding (which fixes
 * the signature order snapshots are verified under) and the Greetings
 * identity proof (which binds a socket to the configured local signing key).
 *
 * Shared by the live session and history replay — both sockets authenticate
 * against the same configured key set, and the party order may only ever be
 * bound once per head.
 */

import { HydraProtocolError } from './errors';
import { greetingsIdentityMessageSchema, headPartiesMessageSchema } from './schemas';
import { hydraVerificationKeyRawHex, normalizeHydraVerificationKeyCborHex } from './snapshot-verification';

export class HydraPartyIdentity {
	private readonly _configuredPartyKeys: ReadonlySet<string>;
	private readonly _expectedNodeVerificationKey: string | undefined;
	private _orderedSnapshotVerificationKeys: string[] | undefined;

	constructor(snapshotVerificationKeys: string[] | undefined, expectedNodeVerificationKey: string | undefined) {
		const configuredPartyKeys = (snapshotVerificationKeys ?? []).map((key) => {
			return hydraVerificationKeyRawHex(normalizeHydraVerificationKeyCborHex(key));
		});
		if (new Set(configuredPartyKeys).size !== configuredPartyKeys.length) {
			throw new HydraProtocolError('Hydra snapshot verification keys must be unique');
		}
		this._configuredPartyKeys = new Set(configuredPartyKeys);
		this._expectedNodeVerificationKey = expectedNodeVerificationKey
			? hydraVerificationKeyRawHex(normalizeHydraVerificationKeyCborHex(expectedNodeVerificationKey))
			: undefined;
		if (
			(this._configuredPartyKeys.size > 0 || this._expectedNodeVerificationKey != null) &&
			(this._expectedNodeVerificationKey == null || !this._configuredPartyKeys.has(this._expectedNodeVerificationKey))
		) {
			throw new HydraProtocolError('Hydra local verification key must belong to the configured participant set');
		}
	}

	get configuredKeyCount(): number {
		return this._configuredPartyKeys.size;
	}

	get hasExpectedNodeKey(): boolean {
		return this._expectedNodeVerificationKey != null;
	}

	/** The on-chain signature order, once an identity-bearing frame bound it. */
	get orderedSnapshotVerificationKeys(): string[] | undefined {
		return this._orderedSnapshotVerificationKeys;
	}

	/**
	 * Bind the party order reported by an on-chain event to the configured key
	 * set. The order may be learned once and must never change within one head.
	 */
	bindSnapshotPartyOrder(message: unknown, assertExpectedHeadId: (message: { headId?: string }) => void): void {
		if (this._configuredPartyKeys.size === 0) return;
		const parsed = headPartiesMessageSchema.parse(message);
		assertExpectedHeadId(parsed);
		const orderedKeys = parsed.parties.map(({ vkey }) => vkey);
		if (
			orderedKeys.length !== this._configuredPartyKeys.size ||
			new Set(orderedKeys).size !== orderedKeys.length ||
			orderedKeys.some((key) => !this._configuredPartyKeys.has(key))
		) {
			throw new HydraProtocolError('Hydra on-chain party set did not match the configured verification keys');
		}
		if (
			this._orderedSnapshotVerificationKeys &&
			this._orderedSnapshotVerificationKeys.some((key, index) => key !== orderedKeys[index])
		) {
			throw new HydraProtocolError('Hydra on-chain party order changed within one configured head');
		}
		this._orderedSnapshotVerificationKeys = orderedKeys;
	}

	/** Prove a Greetings frame identifies the configured local signing key. */
	verifyGreetingsPartyIdentity(message: unknown): void {
		if (this._configuredPartyKeys.size === 0) return;
		const parsed = greetingsIdentityMessageSchema.parse(message);
		const localKey = this._expectedNodeVerificationKey;
		if (localKey == null || parsed.me.vkey !== localKey || parsed.env.party.vkey !== localKey) {
			throw new HydraProtocolError('Hydra Greetings did not identify the configured local signing key');
		}
		const otherKeys = parsed.env.otherParties.map(({ vkey }) => vkey);
		const expectedOtherKeys = [...this._configuredPartyKeys].filter((key) => key !== localKey);
		if (
			otherKeys.length !== expectedOtherKeys.length ||
			new Set(otherKeys).size !== otherKeys.length ||
			otherKeys.some((key) => !this._configuredPartyKeys.has(key) || key === localKey)
		) {
			throw new HydraProtocolError('Hydra Greetings party set did not match the configured participants');
		}
	}
}
