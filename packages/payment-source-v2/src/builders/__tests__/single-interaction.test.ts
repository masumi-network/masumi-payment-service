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

const {
	generateMasumiSmartContractInteractionTransactionAutomaticFees,
	generateMasumiSmartContractWithdrawTransactionAutomaticFees,
} = await import('../single-interaction');

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

	it('offers the spendable wallet UTxOs to Mesh in both fee passes, holding back collateral', async () => {
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
			// Mesh does not exclude `txInCollateral` UTxOs from `selectUtxosFrom`
			// candidates, so coin selection would otherwise spend the collateral
			// reserve and leave the wallet unable to fund the next escrow action.
			expect(builder.selectUtxosFrom).toHaveBeenCalledWith([smallUtxo, largeUtxo]);
			expect(builder.txIn).toHaveBeenCalledTimes(1);
		}
	});

	// Holding the collateral back must never turn a buildable tx into a hard
	// failure — the builders retry with it offered on a genuine coin-selection
	// error. Covered here for both the interaction and withdraw entry points.
	it('retries the interaction build with collateral offered when it cannot balance without it', async () => {
		const collateralUtxo = createUtxo('collateral', '8281874');
		const dustUtxo = createUtxo('dust', '1500000');
		const smartContractUtxo = {
			...createUtxo('contract', '7331310'),
			output: { ...createUtxo('contract', '7331310').output, address: 'addr_test1_contract' },
		};
		const blockchainProvider = {
			fetchProtocolParameters: jest.fn(async () => ({ coinsPerUtxoSize: 4310 })),
			evaluateTx: jest.fn<(tx: string) => Promise<Array<{ budget: { mem: number; steps: number } }>>>(async () => [
				{ budget: { mem: 100, steps: 200 } },
			]),
		};

		MockMeshTxBuilder.failWhenCollateralExcluded = true;
		try {
			await generateMasumiSmartContractInteractionTransactionAutomaticFees(
				'SubmitResult',
				blockchainProvider as never,
				'preprod',
				{ version: 'V3', code: 'script-cbor' },
				'addr_test1_wallet',
				smartContractUtxo as never,
				collateralUtxo as never,
				[collateralUtxo, dustUtxo] as never,
				{ alternative: 1, fields: [] },
				100,
				200,
			);

			expect(builders[0].selectUtxosFrom).toHaveBeenCalledWith([dustUtxo]);
			expect(builders[builders.length - 1].selectUtxosFrom).toHaveBeenCalledWith([collateralUtxo, dustUtxo]);
		} finally {
			MockMeshTxBuilder.failWhenCollateralExcluded = false;
		}
	});

	it('retries the withdraw build with collateral offered when it cannot balance without it', async () => {
		const collateralUtxo = createUtxo('collateral', '8281874');
		const dustUtxo = createUtxo('dust', '1500000');
		const smartContractUtxo = {
			...createUtxo('contract', '7331310'),
			output: { ...createUtxo('contract', '7331310').output, address: 'addr_test1_contract' },
		};
		const blockchainProvider = {
			fetchProtocolParameters: jest.fn(async () => ({ coinsPerUtxoSize: 4310 })),
			evaluateTx: jest.fn<(tx: string) => Promise<Array<{ budget: { mem: number; steps: number } }>>>(async () => [
				{ budget: { mem: 100, steps: 200 } },
			]),
		};

		MockMeshTxBuilder.failWhenCollateralExcluded = true;
		try {
			await generateMasumiSmartContractWithdrawTransactionAutomaticFees(
				'CollectRefund',
				blockchainProvider as never,
				'preprod',
				{ version: 'V3', code: 'script-cbor' },
				'addr_test1_wallet',
				smartContractUtxo as never,
				collateralUtxo as never,
				[collateralUtxo, dustUtxo] as never,
				{ collectAssets: smartContractUtxo.output.amount, collectionAddress: 'addr_test1_wallet' },
				null,
				null,
				100,
				200,
			);

			expect(builders[0].selectUtxosFrom).toHaveBeenCalledWith([dustUtxo]);
			expect(builders[builders.length - 1].selectUtxosFrom).toHaveBeenCalledWith([collateralUtxo, dustUtxo]);
		} finally {
			MockMeshTxBuilder.failWhenCollateralExcluded = false;
		}
	});

	it('propagates a non-balance build failure instead of retrying with collateral', async () => {
		const collateralUtxo = createUtxo('collateral', '8281874');
		const otherUtxo = createUtxo('other', '9000000');
		const smartContractUtxo = {
			...createUtxo('contract', '7331310'),
			output: { ...createUtxo('contract', '7331310').output, address: 'addr_test1_contract' },
		};
		const blockchainProvider = {
			fetchProtocolParameters: jest.fn(async () => ({ coinsPerUtxoSize: 4310 })),
			evaluateTx: jest.fn(async () => {
				throw new Error('PPViewHashesDontMatch');
			}),
		};

		await expect(
			generateMasumiSmartContractInteractionTransactionAutomaticFees(
				'SubmitResult',
				blockchainProvider as never,
				'preprod',
				{ version: 'V3', code: 'script-cbor' },
				'addr_test1_wallet',
				smartContractUtxo as never,
				collateralUtxo as never,
				[collateralUtxo, otherUtxo] as never,
				{ alternative: 1, fields: [] },
				100,
				200,
			),
		).rejects.toThrow('PPViewHashesDontMatch');

		expect(builders).toHaveLength(1);
	});
});
