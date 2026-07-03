import { jest } from '@jest/globals';
import type { UTxO } from '@meshsdk/core';

/**
 * Regression coverage for the V2 batch registry mint/burn builders.
 *
 * The bug these guard against: Mesh's `mint()` flushes the PREVIOUS mint item
 * via `queueMint()`, and `queueMint()` throws
 * `queueMint: Missing mint script information` unless that previous item
 * already carries its `scriptSource`. The original builders attached
 * `mintingScript()` / `mintRedeemerValue()` ONCE after the asset loop, so the
 * 2nd asset's `mint()` flushed an unscripted 1st item and the whole batch
 * threw — meaning the builder only ever worked at size 1.
 *
 * `FakeMeshTxBuilder` below faithfully replicates the relevant slice of Mesh's
 * `mint()` / `mintingScript()` / `mintRedeemerValue()` / `queueMint()`
 * contract (see @meshsdk/transaction dist `MeshTxBuilderCore`). The fake
 * decouples the test from mesh's CBOR serializer while still failing exactly
 * the way the real builder would if a leg is left unscripted — so a future
 * regression to the once-after-the-loop pattern re-breaks this test.
 */

type MintLeg = {
	type: 'Plutus' | 'Native';
	policyId: string;
	assetName: string;
	amount: string;
	scriptSource?: { type: 'Provided'; scriptCode: string };
	redeemer?: unknown;
};

const builtBuilders: FakeMeshTxBuilder[] = [];

class FakeMeshTxBuilder {
	addingPlutusMint = false;
	mintItem: MintLeg | undefined = undefined;
	mints: MintLeg[] = [];
	mintCalls = 0;
	serializer = {
		deserializer: {
			key: {
				deserializeAddress: (_addr: string) => ({
					pubKeyHash: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
				}),
			},
		},
	};

	constructor() {
		builtBuilders.push(this);
	}

	protocolParams() {
		return this;
	}

	// Mirrors mesh: only arms `addingPlutusMint` for the very NEXT mint() call.
	mintPlutusScript() {
		this.addingPlutusMint = true;
		return this;
	}

	// Mirrors mesh: flush the pending leg before starting a new one.
	mint(quantity: string, policy: string, name: string) {
		this.mintCalls += 1;
		if (this.mintItem) {
			this.queueMint();
		}
		this.mintItem = {
			type: this.addingPlutusMint ? 'Plutus' : 'Native',
			policyId: policy,
			assetName: name,
			amount: quantity,
		};
		this.addingPlutusMint = false;
		return this;
	}

	mintingScript(scriptCode: string) {
		if (!this.mintItem) throw new Error('Undefined mint');
		this.mintItem.scriptSource = { type: 'Provided', scriptCode };
		return this;
	}

	mintRedeemerValue(redeemer: unknown, _type?: unknown, exUnits?: unknown) {
		if (!this.mintItem) throw new Error('Undefined mint redeemer');
		this.mintItem.redeemer = { data: redeemer, exUnits };
		return this;
	}

	// Mirrors mesh: an unscripted Plutus leg is the failure the builders must
	// avoid. Same-policy legs merge (asserting redeemer + scriptSource match).
	queueMint() {
		if (!this.mintItem) throw new Error('queueMint: Undefined mint');
		if (!this.mintItem.scriptSource) {
			throw new Error('queueMint: Missing mint script information');
		}
		const current = this.mintItem;
		const samePolicy = this.mints.find((m) => m.policyId === current.policyId);
		if (samePolicy !== undefined) {
			if (JSON.stringify(samePolicy.redeemer) !== JSON.stringify(current.redeemer)) {
				throw new Error('queueMint: Redeemer for the same policy id must be the same');
			}
			if (JSON.stringify(samePolicy.scriptSource) !== JSON.stringify(current.scriptSource)) {
				throw new Error('queueMint: Script source for the same policy id must be the same');
			}
		}
		this.mints.push(current);
		this.mintItem = undefined;
	}

	metadataValue() {
		return this;
	}
	txIn() {
		return this;
	}
	selectUtxosFrom() {
		return this;
	}
	txInCollateral() {
		return this;
	}
	setTotalCollateral() {
		return this;
	}
	txOut() {
		return this;
	}
	requiredSignerHash() {
		return this;
	}
	setNetwork() {
		return this;
	}
	changeAddress() {
		return this;
	}

	async complete() {
		// mesh flushes the last pending leg at complete()
		if (this.mintItem) {
			this.queueMint();
		}
		return 'beadface';
	}
}

jest.unstable_mockModule('@meshsdk/core', () => ({
	MeshTxBuilder: FakeMeshTxBuilder,
}));

jest.unstable_mockModule('@/utils/mesh-cost-model-sync', () => ({
	getCachedChainProtocolParameters: () => null,
}));

jest.unstable_mockModule('../../utils/mesh-cost-model-sync', () => ({
	syncMeshCostModelsFromChainV2: async () => undefined,
}));

const {
	generateRegistryBatchMintTransaction,
	generateRegistryBatchDeregisterTransactionAutomaticFees,
	generateRegistryBatchUpdateTransactionAutomaticFees,
} = await import('../batch-registry');

const POLICY_ID = 'a'.repeat(56);
const SCRIPT = { version: 'V3' as const, code: 'aabbccdd' };

const PROTOCOL_PARAMS = {
	priceMem: '0.0577',
	priceStep: '0.0000721',
	collateralPercentage: 150,
};

function utxo(
	txHash: string,
	outputIndex: number,
	lovelace = '5000000',
	extraAmount: Array<{ unit: string; quantity: string }> = [],
): UTxO {
	return {
		input: { txHash, outputIndex },
		output: {
			address: 'addr_test1placeholder',
			amount: [{ unit: 'lovelace', quantity: lovelace }, ...extraAmount],
		},
	} as unknown as UTxO;
}

const fetcher = {
	fetchProtocolParameters: async () => PROTOCOL_PARAMS,
} as never;

beforeEach(() => {
	builtBuilders.length = 0;
});

describe('generateRegistryBatchMintTransaction', () => {
	const items = [
		{
			recipientWalletAddress: 'addr_test1recipient_a',
			fundingLovelace: '2000000',
			assetName: '01' + 'aa'.repeat(28) + '000000',
			firstUtxo: utxo('1111', 0),
			metadata: { name: 'Agent A' },
		},
		{
			recipientWalletAddress: 'addr_test1recipient_b',
			fundingLovelace: '2000000',
			assetName: '02' + 'bb'.repeat(28) + '000000',
			firstUtxo: utxo('2222', 1),
			metadata: { name: 'Agent B' },
		},
	];

	it('builds a multi-asset (>=2) mint without throwing queueMint: Missing mint script information', async () => {
		const collateral = utxo('cccc', 0);
		const wallet = [utxo('cccc', 0), utxo('dddd', 0), utxo('eeee', 0)];

		await expect(
			generateRegistryBatchMintTransaction(
				fetcher,
				'preprod',
				SCRIPT,
				'addr_test1minter',
				POLICY_ID,
				items,
				collateral,
				wallet,
			),
		).resolves.toBe('beadface');

		expect(builtBuilders).toHaveLength(1);
		const builder = builtBuilders[0];
		// Every minted leg must be queued, typed Plutus, scripted, and carry the
		// shared MintAction redeemer. The pre-fix code typed legs 2..N as Native
		// (mintPlutusScript only armed the first mint) and never scripted legs.
		expect(builder.mints).toHaveLength(2);
		for (const leg of builder.mints) {
			expect(leg.type).toBe('Plutus');
			expect(leg.scriptSource).toEqual({ type: 'Provided', scriptCode: SCRIPT.code });
			expect(leg.redeemer).toEqual({ data: { alternative: 0, fields: [] }, exUnits: expect.anything() });
		}
		expect(builder.mints.map((m) => m.assetName).sort()).toEqual(items.map((i) => i.assetName).sort());
	});

	it('still builds the single-item batch (no regression at size 1)', async () => {
		const collateral = utxo('cccc', 0);
		const wallet = [utxo('cccc', 0), utxo('dddd', 0)];

		await expect(
			generateRegistryBatchMintTransaction(
				fetcher,
				'preprod',
				SCRIPT,
				'addr_test1minter',
				POLICY_ID,
				[items[0]],
				collateral,
				wallet,
			),
		).resolves.toBe('beadface');
		expect(builtBuilders[0].mints).toHaveLength(1);
		expect(builtBuilders[0].mints[0].type).toBe('Plutus');
	});
});

describe('generateRegistryBatchDeregisterTransactionAutomaticFees', () => {
	it('builds a multi-asset (>=2) burn without throwing queueMint: Missing mint script information', async () => {
		const assetNameA = '01' + 'aa'.repeat(28) + '000000';
		const assetNameB = '02' + 'bb'.repeat(28) + '000000';
		const items = [
			{
				assetName: assetNameA,
				assetUtxo: utxo('1111', 0, '2000000', [{ unit: POLICY_ID + assetNameA, quantity: '1' }]),
			},
			{
				assetName: assetNameB,
				assetUtxo: utxo('2222', 0, '2000000', [{ unit: POLICY_ID + assetNameB, quantity: '1' }]),
			},
		];
		const collateral = utxo('cccc', 0);
		const wallet = [utxo('cccc', 0), utxo('dddd', 0)];

		const burnFetcher = {
			fetchProtocolParameters: async () => PROTOCOL_PARAMS,
			evaluateTx: async () => [{ tag: 'MINT', index: 0, budget: { mem: 1_000_000, steps: 500_000_000 } }],
		} as never;

		await expect(
			generateRegistryBatchDeregisterTransactionAutomaticFees(
				burnFetcher,
				'preprod',
				SCRIPT,
				'addr_test1burner',
				POLICY_ID,
				items,
				collateral,
				wallet,
			),
		).resolves.toBe('beadface');

		// Two builders are constructed: the evaluation pass and the final pass.
		// Both must queue both burn legs as scripted Plutus mints (qty -1).
		const finalBuilder = builtBuilders[builtBuilders.length - 1];
		expect(finalBuilder.mints).toHaveLength(2);
		for (const leg of finalBuilder.mints) {
			expect(leg.type).toBe('Plutus');
			expect(leg.amount).toBe('-1');
			expect(leg.scriptSource).toEqual({ type: 'Provided', scriptCode: SCRIPT.code });
			expect(leg.redeemer).toEqual({ data: { alternative: 2, fields: [] }, exUnits: expect.anything() });
		}
	});
});

describe('generateRegistryBatchUpdateTransactionAutomaticFees', () => {
	const oldA = '10' + 'aa'.repeat(28) + '000000';
	const newA = '10' + 'aa'.repeat(28) + '000001';
	const oldB = '11' + 'bb'.repeat(28) + '000000';
	const newB = '11' + 'bb'.repeat(28) + '000001';

	function updateItems() {
		return [
			{
				oldAssetName: oldA,
				newAssetName: newA,
				assetUtxo: utxo('1111', 0, '2000000', [{ unit: POLICY_ID + oldA, quantity: '1' }]),
				recipientWalletAddress: 'addr_test1recipient_a',
				fundingLovelace: '2000000',
				metadata: { name: 'Agent A v2' },
			},
			{
				oldAssetName: oldB,
				newAssetName: newB,
				assetUtxo: utxo('2222', 0, '2000000', [{ unit: POLICY_ID + oldB, quantity: '1' }]),
				recipientWalletAddress: 'addr_test1recipient_b',
				fundingLovelace: '2000000',
				metadata: { name: 'Agent B v2' },
			},
		];
	}

	const updateFetcher = {
		fetchProtocolParameters: async () => PROTOCOL_PARAMS,
		evaluateTx: async () => [{ tag: 'MINT', index: 0, budget: { mem: 1_000_000, steps: 500_000_000 } }],
	} as never;

	it('builds a multi-asset (>=2) update: each item burns old (-1) and mints new (+1) under ONE UpdateAction redeemer', async () => {
		const collateral = utxo('cccc', 0);
		const wallet = [utxo('cccc', 0), utxo('dddd', 0)];

		await expect(
			generateRegistryBatchUpdateTransactionAutomaticFees(
				updateFetcher,
				'preprod',
				SCRIPT,
				'addr_test1holder',
				POLICY_ID,
				updateItems(),
				collateral,
				wallet,
			),
		).resolves.toBe('beadface');

		// 2 items × (burn old + mint new) = 4 legs. All must be scripted Plutus and
		// carry the SAME UpdateAction redeemer (alt=1) so queueMint merges them into
		// one atomic policy bucket (this is what makes it a batch UpdateAction).
		const finalBuilder = builtBuilders[builtBuilders.length - 1];
		expect(finalBuilder.mints).toHaveLength(4);
		for (const leg of finalBuilder.mints) {
			expect(leg.type).toBe('Plutus');
			expect(leg.scriptSource).toEqual({ type: 'Provided', scriptCode: SCRIPT.code });
			expect(leg.redeemer).toEqual({ data: { alternative: 1, fields: [] }, exUnits: expect.anything() });
		}
		const burned = finalBuilder.mints
			.filter((m) => m.amount === '-1')
			.map((m) => m.assetName)
			.sort();
		const minted = finalBuilder.mints
			.filter((m) => m.amount !== '-1')
			.map((m) => m.assetName)
			.sort();
		expect(burned).toEqual([oldA, oldB].sort());
		expect(minted).toEqual([newA, newB].sort());
	});

	it('rejects an item whose assetUtxo does not hold the old asset', async () => {
		const items = updateItems();
		// Strip the asset from the first item's UTxO — nothing to burn.
		items[0].assetUtxo = utxo('1111', 0, '2000000');
		await expect(
			generateRegistryBatchUpdateTransactionAutomaticFees(
				updateFetcher,
				'preprod',
				SCRIPT,
				'addr_test1holder',
				POLICY_ID,
				items,
				utxo('cccc', 0),
				[utxo('cccc', 0)],
			),
		).rejects.toThrow(/does not contain asset/);
	});

	it('rejects when the collateral UTxO overlaps an asset input', async () => {
		const items = updateItems();
		await expect(
			generateRegistryBatchUpdateTransactionAutomaticFees(
				updateFetcher,
				'preprod',
				SCRIPT,
				'addr_test1holder',
				POLICY_ID,
				items,
				items[0].assetUtxo, // collateral == an asset input -> phase-1 violation
				[utxo('cccc', 0)],
			),
		).rejects.toThrow(/overlaps with a spending input/);
	});
});
