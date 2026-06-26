import type { UTxO } from '@meshsdk/core';
import {
	generateRegistryAssetNameV2,
	registryNonceForIndex,
	V2_REGISTRY_MAX_MINTS_PER_UTXO,
} from '@/services/registry/asset-name';

// Minimal UTxO fixture: generateRegistryAssetNameV2 only reads input.txHash /
// input.outputIndex, so we cast a partial shape.
function makeUtxo(txHash: string, outputIndex: number): UTxO {
	return { input: { txHash, outputIndex } } as unknown as UTxO;
}

const TX_A = 'aa'.repeat(32); // 64 hex chars (32-byte tx id)
const TX_B = 'bb'.repeat(32);

describe('registryNonceForIndex', () => {
	it('maps batch index to the 0x10-based nonce byte', () => {
		expect(registryNonceForIndex(0)).toBe('10');
		expect(registryNonceForIndex(1)).toBe('11');
		expect(registryNonceForIndex(V2_REGISTRY_MAX_MINTS_PER_UTXO - 1)).toBe('ff');
	});

	it('caps at the 240-nonce range and rejects bad indices', () => {
		expect(() => registryNonceForIndex(V2_REGISTRY_MAX_MINTS_PER_UTXO)).toThrow(/nonce range/);
		expect(() => registryNonceForIndex(-1)).toThrow();
		expect(() => registryNonceForIndex(1.5)).toThrow();
	});
});

describe('generateRegistryAssetNameV2', () => {
	it('produces a 64-hex-char name with the default 0x10 nonce', () => {
		const name = generateRegistryAssetNameV2(makeUtxo(TX_A, 0));
		expect(name).toHaveLength(64);
		expect(name.slice(0, 2)).toBe('10'); // nonce
		expect(name.slice(58, 64)).toBe('000000'); // version
	});

	it('oneshot: the SAME utxo with different nonces shares the root hash but yields distinct names', () => {
		const utxo = makeUtxo(TX_A, 3);
		const n0 = generateRegistryAssetNameV2(utxo, registryNonceForIndex(0));
		const n1 = generateRegistryAssetNameV2(utxo, registryNonceForIndex(1));

		// Distinct asset names (distinct nonce prefix) — so one UTxO can seed a
		// whole batch.
		expect(n0).not.toBe(n1);
		expect(n0.slice(0, 2)).toBe('10');
		expect(n1.slice(0, 2)).toBe('11');

		// ...but the 28-byte root hash (chars 2..58) is identical, which is what
		// the on-chain validator checks against the spent input.
		expect(n0.slice(2, 58)).toBe(n1.slice(2, 58));
	});

	it('derives a different root hash for a different utxo', () => {
		const a = generateRegistryAssetNameV2(makeUtxo(TX_A, 0));
		const b = generateRegistryAssetNameV2(makeUtxo(TX_B, 0));
		expect(a.slice(2, 58)).not.toBe(b.slice(2, 58));
	});

	it('rejects nonces outside the 0x10..0xff range or wrong shape', () => {
		const utxo = makeUtxo(TX_A, 0);
		expect(() => generateRegistryAssetNameV2(utxo, '0f')).toThrow();
		expect(() => generateRegistryAssetNameV2(utxo, '5')).toThrow();
		expect(() => generateRegistryAssetNameV2(utxo, 'gg')).toThrow();
	});
});

// Regression guard for the V2 register batch "oneshot" invariant: ONE wallet
// UTxO must be able to seed a whole batch of agents (one nonce per agent). A
// past bug demanded one distinct wallet UTxO per agent, so a wallet with fewer
// UTxOs than queued agents threw "Insufficient wallet UTXOs". This locks in the
// property the register services rely on (see docs/adr/0009). If anyone
// reintroduces a per-agent-UTxO requirement, these assertions break.
describe('oneshot batch invariant', () => {
	it('one shared utxo seeds a full batch of distinct, valid asset names', () => {
		const sharedUtxo = makeUtxo(TX_A, 7);
		const batchSize = 7; // mirrors REGISTRY_BATCH_SIZE in the register services

		const names = Array.from({ length: batchSize }, (_, idx) =>
			generateRegistryAssetNameV2(sharedUtxo, registryNonceForIndex(idx)),
		);

		// Every name is a well-formed 32-byte (64 hex char) registry asset name.
		for (const name of names) {
			expect(name).toHaveLength(64);
			expect(name.slice(58, 64)).toBe('000000');
		}

		// All distinct — so the mint contract's quantity==1-per-asset rule holds.
		expect(new Set(names).size).toBe(batchSize);

		// All share the SAME 28-byte root hash (derived from the one shared utxo),
		// which is exactly what lets a single consumed input authorize them all.
		const roots = new Set(names.map((n) => n.slice(2, 58)));
		expect(roots.size).toBe(1);
	});

	it('exposes 240 nonces per utxo, all producing valid names', () => {
		expect(V2_REGISTRY_MAX_MINTS_PER_UTXO).toBe(240);
		const utxo = makeUtxo(TX_B, 0);
		// First and last legal nonce both produce valid names from one utxo.
		expect(() => generateRegistryAssetNameV2(utxo, registryNonceForIndex(0))).not.toThrow();
		expect(() =>
			generateRegistryAssetNameV2(utxo, registryNonceForIndex(V2_REGISTRY_MAX_MINTS_PER_UTXO - 1)),
		).not.toThrow();
	});
});
