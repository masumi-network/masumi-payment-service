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

	complete = jest.fn(async () => {
		if (MockMeshTxBuilder.failWhenCollateralExcluded) {
			const calls = this.selectUtxosFrom.mock.calls;
			const offered = (calls.length > 0 ? calls[calls.length - 1][0] : undefined) as
				| Array<{ input: { txHash: string } }>
				| undefined;
			if (!(offered?.some((utxo) => utxo.input.txHash === 'collateral') ?? false)) {
				throw new Error('UTxO Balance Insufficient');
			}
		}
		return `unsigned-tx-${builders.indexOf(this) + 1}`;
	});

	static failWhenCollateralExcluded = false;

	constructor() {
		builders.push(this);
	}
}

// Mocks apply per test file to every transitively-loaded module, so this must
// enumerate every symbol anything in the import graph pulls from '@meshsdk/core'
// — not just the ones this builder uses. See CLAUDE.md > Mesh SDK isolation.
jest.unstable_mockModule('@meshsdk/core', () => ({
	MeshTxBuilder: MockMeshTxBuilder,
	mOutputReference: jest.fn(),
	deserializeDatum: jest.fn(),
	resolveTxHash: jest.fn(() => 'resolved-tx-hash'),
	SLOT_CONFIG_NETWORK: { preprod: {}, mainnet: {} },
	unixTimeToEnclosingSlot: jest.fn(() => 0),
	Transaction: class {},
	MeshWallet: class {},
	BlockfrostProvider: class {},
	applyParamsToScript: jest.fn(() => 'applied-script'),
	serializePlutusScript: jest.fn(() => ({ address: 'addr_test1_contract' })),
	deserializeAddress: jest.fn(() => ({ pubKeyHash: 'wallet-key-hash' })),
}));

jest.unstable_mockModule('@meshsdk/core-cst', () => ({
	resolvePlutusScriptAddress: jest.fn(() => 'addr_test1_contract'),
}));

jest.unstable_mockModule('@masumi/payment-core', () => ({
	convertNetworkToId: jest.fn(() => 0),
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
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

const {
	generateMasumiSmartContractBatchInteractionTransactionAutomaticFees,
	generateMasumiSmartContractBatchWithdrawTransactionAutomaticFees,
} = await import('../batch-interaction');

function createUtxo(txHash: string, lovelace: string) {
	return {
		input: { txHash, outputIndex: 0 },
		output: { address: 'addr_test1_wallet', amount: [{ unit: 'lovelace', quantity: lovelace }] },
	};
}

function createScriptUtxo(txHash: string) {
	return {
		...createUtxo(txHash, '7331310'),
		output: { ...createUtxo(txHash, '7331310').output, address: 'addr_test1_contract' },
	};
}

function spendEvaluation() {
	return jest.fn(async () => [{ tag: 'SPEND', index: 0, budget: { mem: 100, steps: 200 } }]);
}

const SCRIPT = { version: 'V3' as const, code: 'script-cbor' };

describe('V2 batch builders — collateral fallback', () => {
	beforeEach(() => {
		builders.length = 0;
		MockMeshTxBuilder.failWhenCollateralExcluded = false;
	});

	it('holds the collateral back when the wallet can afford it (interaction)', async () => {
		const collateralUtxo = createUtxo('collateral', '8281874');
		const largeUtxo = createUtxo('large', '485435616');
		const blockchainProvider = {
			fetchProtocolParameters: jest.fn(async () => ({ coinsPerUtxoSize: 4310 })),
			evaluateTx: spendEvaluation(),
		};

		await generateMasumiSmartContractBatchInteractionTransactionAutomaticFees(
			blockchainProvider as never,
			'preprod',
			SCRIPT,
			'addr_test1_wallet',
			collateralUtxo as never,
			[collateralUtxo, largeUtxo] as never,
			[
				{
					type: 'SubmitResult',
					smartContractUtxo: createScriptUtxo('contract'),
					newInlineDatum: { alternative: 1, fields: [] },
				},
			] as never,
			100,
			200,
		);

		// Length assertion matters: an empty `builders` array would make the loop
		// below pass vacuously.
		expect(builders).toHaveLength(2);
		for (const builder of builders) {
			expect(builder.selectUtxosFrom).toHaveBeenCalledWith([largeUtxo]);
		}
	});

	it('retries with the collateral offered when the interaction batch cannot balance without it', async () => {
		const collateralUtxo = createUtxo('collateral', '8281874');
		const dustUtxo = createUtxo('dust', '1500000');
		const blockchainProvider = {
			fetchProtocolParameters: jest.fn(async () => ({ coinsPerUtxoSize: 4310 })),
			evaluateTx: spendEvaluation(),
		};

		MockMeshTxBuilder.failWhenCollateralExcluded = true;

		await generateMasumiSmartContractBatchInteractionTransactionAutomaticFees(
			blockchainProvider as never,
			'preprod',
			SCRIPT,
			'addr_test1_wallet',
			collateralUtxo as never,
			[collateralUtxo, dustUtxo] as never,
			[
				{
					type: 'SubmitResult',
					smartContractUtxo: createScriptUtxo('contract'),
					newInlineDatum: { alternative: 1, fields: [] },
				},
			] as never,
			100,
			200,
		);

		expect(builders[0].selectUtxosFrom).toHaveBeenCalledWith([dustUtxo]);
		expect(builders[builders.length - 1].selectUtxosFrom).toHaveBeenCalledWith([collateralUtxo, dustUtxo]);
	});

	// The batch WITHDRAW wrapper had no fallback of any kind before this change,
	// and it is the path batch refund collection uses.
	it('retries with the collateral offered when the withdraw batch cannot balance without it', async () => {
		const collateralUtxo = createUtxo('collateral', '8281874');
		const dustUtxo = createUtxo('dust', '1500000');
		const scriptUtxo = createScriptUtxo('contract');
		const blockchainProvider = {
			fetchProtocolParameters: jest.fn(async () => ({ coinsPerUtxoSize: 4310 })),
			evaluateTx: spendEvaluation(),
		};

		MockMeshTxBuilder.failWhenCollateralExcluded = true;

		await generateMasumiSmartContractBatchWithdrawTransactionAutomaticFees(
			blockchainProvider as never,
			'preprod',
			SCRIPT,
			'addr_test1_wallet',
			collateralUtxo as never,
			[collateralUtxo, dustUtxo] as never,
			[
				{
					type: 'CollectRefund',
					smartContractUtxo: scriptUtxo,
					collection: { collectAssets: scriptUtxo.output.amount, collectionAddress: 'addr_test1_wallet' },
					fee: null,
					collateralReturn: null,
				},
			] as never,
			100,
			200,
		);

		expect(builders[0].selectUtxosFrom).toHaveBeenCalledWith([dustUtxo]);
		expect(builders[builders.length - 1].selectUtxosFrom).toHaveBeenCalledWith([collateralUtxo, dustUtxo]);
	});
});
