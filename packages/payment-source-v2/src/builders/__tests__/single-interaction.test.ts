import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const builders: MockMeshTxBuilder[] = [];

class MockMeshTxBuilder {
	serializer = {
		deserializer: {
			key: {
				deserializeAddress: jest.fn(() => ({ pubKeyHash: 'wallet-key-hash' })),
			},
		},
	};
	protocolParams = jest.fn(() => this);
	spendingPlutusScript = jest.fn(() => this);
	txIn = jest.fn(() => this) as jest.Mock;
	txInScript = jest.fn(() => this);
	txInRedeemerValue = jest.fn(() => this);
	txInInlineDatumPresent = jest.fn(() => this);
	txInCollateral = jest.fn(() => this) as jest.Mock;
	setTotalCollateral = jest.fn(() => this);
	txOut = jest.fn(() => this);
	txOutInlineDatumValue = jest.fn(() => this);
	selectUtxosFrom = jest.fn(() => this) as jest.Mock;
	changeAddress = jest.fn(() => this);
	invalidBefore = jest.fn(() => this);
	invalidHereafter = jest.fn(() => this);
	requiredSignerHash = jest.fn(() => this);
	setNetwork = jest.fn(() => this);
	metadataValue = jest.fn(() => this);
	complete = jest.fn(async () => `unsigned-tx-${builders.indexOf(this) + 1}`);

	constructor() {
		builders.push(this);
	}
}

jest.unstable_mockModule('@meshsdk/core', () => ({
	MeshTxBuilder: MockMeshTxBuilder,
	mOutputReference: jest.fn(),
}));

jest.unstable_mockModule('@meshsdk/core-cst', () => ({
	resolvePlutusScriptAddress: jest.fn(() => 'addr_test1_contract'),
}));

jest.unstable_mockModule('@masumi/payment-core', () => ({
	convertNetworkToId: jest.fn(() => 0),
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: {
		info: jest.fn(),
		warn: jest.fn(),
		error: jest.fn(),
		debug: jest.fn(),
	},
}));

jest.unstable_mockModule('@/utils/min-utxo', () => ({
	calculateMinUtxo: jest.fn(() => ({ minUtxoLovelace: 1_000_000n })),
	getLovelaceFromAmounts: jest.fn(() => 7_000_000n),
	getNativeTokenCount: jest.fn(() => 1),
	calculateTopUpAmount: jest.fn(() => 0n),
}));

jest.unstable_mockModule('@/utils/mesh-cost-model-sync', () => ({
	getCachedChainProtocolParameters: jest.fn(() => null),
}));

jest.unstable_mockModule('../../utils/mesh-cost-model-sync', () => ({
	syncMeshCostModelsFromChainV2: jest.fn(),
}));

const { generateMasumiSmartContractInteractionTransactionAutomaticFees } = await import('../single-interaction');

function createUtxo(txHash: string, lovelace: string) {
	return {
		input: {
			txHash,
			outputIndex: 0,
		},
		output: {
			address: 'addr_test1_wallet',
			amount: [{ unit: 'lovelace', quantity: lovelace }],
		},
	};
}

describe('V2 single-item smart-contract input selection', () => {
	beforeEach(() => {
		builders.length = 0;
	});

	it('offers every wallet UTxO to Mesh in both fee passes, including collateral', async () => {
		const collateralUtxo = createUtxo('collateral', '8281874');
		const smallUtxo = createUtxo('small', '3336392');
		const largeUtxo = createUtxo('large', '485435616');
		const smartContractUtxo = {
			...createUtxo('contract', '7331310'),
			output: {
				...createUtxo('contract', '7331310').output,
				address: 'addr_test1_contract',
			},
		};
		const evaluateTx = jest.fn(async () => [{ budget: { mem: 100, steps: 200 } }]);
		const blockchainProvider = {
			fetchProtocolParameters: jest.fn(async () => ({ coinsPerUtxoSize: 4310 })),
			evaluateTx,
		};

		await generateMasumiSmartContractInteractionTransactionAutomaticFees(
			'SubmitResult',
			blockchainProvider as never,
			'preprod',
			{ version: 'V3', code: 'script-cbor' },
			'addr_test1_wallet',
			smartContractUtxo as never,
			collateralUtxo as never,
			[collateralUtxo, smallUtxo, largeUtxo] as never,
			{ alternative: 1, fields: [] },
			100,
			200,
			undefined,
			5_000_000n,
		);

		expect(builders).toHaveLength(2);
		for (const builder of builders) {
			expect(builder.txInCollateral).toHaveBeenCalledWith('collateral', 0);
			expect(builder.selectUtxosFrom).toHaveBeenCalledWith([collateralUtxo, smallUtxo, largeUtxo]);
			expect(builder.txIn).toHaveBeenCalledTimes(1);
		}
	});
});
