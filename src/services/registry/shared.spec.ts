import { jest } from '@jest/globals';
import type { UTxO } from '@meshsdk/core';
import { SERVICE_CONSTANTS } from '@masumi/payment-core/config';

/**
 * Regression coverage for the V2 registry UpdateAction transaction builder
 * (`generateRegistryUpdateTransactionAutomaticFees`).
 *
 * The bug this guards against: an update burns the old asset and mints the new
 * one — two mint legs under one policy. Mesh's `mint()` flushes the PREVIOUS
 * leg via `queueMint()`, and `queueMint()` throws
 * `queueMint: Missing mint script information` unless that leg already carries
 * its `scriptSource`. The original builder attached `mintingScript()` /
 * `mintRedeemerValue()` ONCE after both `mint()` calls, so the mint-new leg's
 * `mint()` flushed an unscripted burn-old leg and the whole update threw — the
 * exact `queueMint: Missing mint script information` surfaced in production.
 *
 * `FakeMeshTxBuilder` faithfully replicates the relevant slice of Mesh's
 * `mint()` / `mintingScript()` / `mintRedeemerValue()` / `queueMint()` contract
 * (see @meshsdk/transaction dist `MeshTxBuilderCore`) so a regression to the
 * once-after-both pattern re-breaks this test.
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

	mintPlutusScript() {
		this.addingPlutusMint = true;
		return this;
	}

	mint(quantity: string, policy: string, name: string) {
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
	syncMeshCostModelsFromChain: async () => undefined,
}));

const { generateRegistryUpdateTransactionAutomaticFees } = await import('./shared');

const POLICY_ID = 'a'.repeat(56);
const SCRIPT = { version: 'V3' as const, code: 'aabbccdd' };

function utxo(txHash: string, outputIndex: number): UTxO {
	return {
		input: { txHash, outputIndex },
		output: {
			address: 'addr_test1placeholder',
			amount: [{ unit: 'lovelace', quantity: '5000000' }],
		},
	} as unknown as UTxO;
}

const provider = {
	fetchProtocolParameters: async () => ({
		priceMem: '0.0577',
		priceStep: '0.0000721',
		collateralPercentage: 150,
	}),
	evaluateTx: async () => [{ tag: 'MINT', index: 0, budget: { mem: 1_000_000, steps: 500_000_000 } }],
} as never;

beforeEach(() => {
	builtBuilders.length = 0;
});

describe('generateRegistryUpdateTransactionAutomaticFees', () => {
	it('builds the burn-old + mint-new pair without throwing queueMint: Missing mint script information', async () => {
		const oldAssetName = '01' + 'aa'.repeat(28) + '000000';
		const newAssetName = '02' + 'bb'.repeat(28) + '000000';

		await expect(
			generateRegistryUpdateTransactionAutomaticFees(
				provider,
				'preprod',
				SCRIPT,
				'addr_test1updater',
				'addr_test1recipient',
				'2000000',
				POLICY_ID,
				oldAssetName,
				newAssetName,
				utxo('1111', 0),
				utxo('cccc', 0),
				[utxo('dddd', 0)],
				{ name: 'Agent A', description: 'desc' },
			),
		).resolves.toBe('beadface');

		// The wrapper builds twice (evaluation pass + final pass). Each must queue
		// both legs as scripted Plutus mints under the shared UpdateAction redeemer.
		const finalBuilder = builtBuilders[builtBuilders.length - 1];
		expect(finalBuilder.mints).toHaveLength(2);
		const byAsset = Object.fromEntries(finalBuilder.mints.map((m) => [m.assetName, m]));
		expect(byAsset[oldAssetName].amount).toBe('-1');
		expect(byAsset[newAssetName].amount).toBe(String(SERVICE_CONSTANTS.SMART_CONTRACT.mintQuantity));
		for (const leg of finalBuilder.mints) {
			expect(leg.type).toBe('Plutus');
			expect(leg.scriptSource).toEqual({ type: 'Provided', scriptCode: SCRIPT.code });
			// UpdateAction redeemer alternative is 1.
			expect(leg.redeemer).toEqual({ data: { alternative: 1, fields: [] }, exUnits: expect.anything() });
		}
	});
});
