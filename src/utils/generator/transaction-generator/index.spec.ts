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
	spendingPlutusScript = jest.fn(() => this);
	txIn = jest.fn(() => this) as jest.Mock<any>;
	txInScript = jest.fn(() => this);
	txInRedeemerValue = jest.fn(() => this);
	txInInlineDatumPresent = jest.fn(() => this);
	txInCollateral = jest.fn(() => this) as jest.Mock<any>;
	setTotalCollateral = jest.fn(() => this) as jest.Mock<any>;
	txOut = jest.fn(() => this);
	txOutInlineDatumValue = jest.fn(() => this);
	selectUtxosFrom = jest.fn(() => this) as jest.Mock<any>;
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

jest.unstable_mockModule('@/utils/converter/network-convert', () => ({
	convertNetworkToId: jest.fn(() => 0),
}));

jest.unstable_mockModule('@/utils/min-utxo', () => ({
	calculateMinUtxo: jest.fn(() => ({ minUtxoLovelace: 1_000_000n })),
	getLovelaceFromAmounts: jest.fn(() => 7_000_000n),
	getNativeTokenCount: jest.fn(() => 1),
	calculateTopUpAmount: jest.fn(() => 0n),
}));

jest.unstable_mockModule('@/utils/config', () => ({
	CONSTANTS: {
		FALLBACK_COINS_PER_UTXO_SIZE: 4310,
	},
}));

jest.unstable_mockModule('@/utils/logger', () => ({
	logger: {
		info: jest.fn(),
		warn: jest.fn(),
		error: jest.fn(),
		debug: jest.fn(),
	},
}));

const {
	generateMasumiSmartContractInteractionTransactionAutomaticFees,
	generateMasumiSmartContractWithdrawTransactionAutomaticFees,
} = await import('./index');

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

describe('automatic smart-contract transaction input selection', () => {
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
		const evaluateTx = jest.fn() as jest.Mock<any>;
		evaluateTx.mockResolvedValue([{ budget: { mem: 100, steps: 200 } }]);
		const blockchainProvider = {
			fetchProtocolParameters: jest.fn(async () => ({ coinsPerUtxoSize: 4310 })),
			evaluateTx,
		};

		const result = await generateMasumiSmartContractInteractionTransactionAutomaticFees(
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
		);

		expect(result).toBe('unsigned-tx-2');
		expect(blockchainProvider.evaluateTx).toHaveBeenCalledWith('unsigned-tx-1');
		expect(builders).toHaveLength(2);
		for (const builder of builders) {
			expect(builder.txInCollateral).toHaveBeenCalledWith('collateral', 0);
			expect(builder.setTotalCollateral).toHaveBeenCalledWith('3000000');
			// Mesh does not exclude `txInCollateral` UTxOs from `selectUtxosFrom`
			// candidates, so coin selection would otherwise spend the collateral
			// reserve and leave the wallet unable to fund the next escrow action.
			expect(builder.selectUtxosFrom).toHaveBeenCalledWith([smallUtxo, largeUtxo]);
			expect(builder.txIn).toHaveBeenCalledTimes(1);
			expect(builder.txIn).toHaveBeenCalledWith(
				'contract',
				0,
				smartContractUtxo.output.amount,
				'addr_test1_contract',
				0,
			);
		}
	});

	// The whole point of the rework: a static exclusion turned a buildable tx
	// into a hard failure whenever the collateral was the only funder big
	// enough. Prefer holding it back, but never at the cost of not transacting.
	it('retries with the collateral offered when the tx cannot balance without it', async () => {
		const collateralUtxo = createUtxo('collateral', '8281874');
		const dustUtxo = createUtxo('dust', '1500000');
		const smartContractUtxo = {
			...createUtxo('contract', '7331310'),
			output: { ...createUtxo('contract', '7331310').output, address: 'addr_test1_contract' },
		};
		const blockchainProvider = {
			fetchProtocolParameters: jest.fn(async () => ({ coinsPerUtxoSize: 4310 })),
			evaluateTx: jest.fn(async () => [{ budget: { mem: 100, steps: 200 } }]),
		};

		MockMeshTxBuilder.failWhenCollateralExcluded = true;
		try {
			const result = await generateMasumiSmartContractInteractionTransactionAutomaticFees(
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

			expect(result).toBeDefined();
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

	// collect-refund — the path that wedged on the live server — goes through the
	// WITHDRAW builder, not the interaction one. Its fallback is wired
	// separately, so it needs its own coverage.
	it('retries the withdraw build with collateral offered when it cannot balance without it', async () => {
		const collateralUtxo = createUtxo('collateral', '8281874');
		const dustUtxo = createUtxo('dust', '1500000');
		const smartContractUtxo = {
			...createUtxo('contract', '7331310'),
			output: { ...createUtxo('contract', '7331310').output, address: 'addr_test1_contract' },
		};
		const blockchainProvider = {
			fetchProtocolParameters: jest.fn(async () => ({ coinsPerUtxoSize: 4310 })),
			evaluateTx: jest.fn(async () => [{ budget: { mem: 100, steps: 200 } }]),
		};

		MockMeshTxBuilder.failWhenCollateralExcluded = true;
		try {
			const result = await generateMasumiSmartContractWithdrawTransactionAutomaticFees(
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

			expect(result).toBeDefined();
			expect(builders[0].selectUtxosFrom).toHaveBeenCalledWith([dustUtxo]);
			expect(builders[builders.length - 1].selectUtxosFrom).toHaveBeenCalledWith([collateralUtxo, dustUtxo]);
		} finally {
			MockMeshTxBuilder.failWhenCollateralExcluded = false;
		}
	});
});
