import { jest } from '@jest/globals';
import type { Mock } from 'jest-mock';

type AnyMock = Mock<(...args: any[]) => any>;

const mockGenerateWalletExtended = jest.fn() as AnyMock;
const mockConvertNetwork = jest.fn() as AnyMock;
const mockCreateTxWindow = jest.fn() as AnyMock;
const mockResolveTxHash = jest.fn() as AnyMock;

const mockSendAssets = jest.fn() as AnyMock;
const mockSetMetadata = jest.fn() as AnyMock;
const mockSetNetwork = jest.fn() as AnyMock;
const mockInvalidBefore = jest.fn() as AnyMock;
const mockInvalidHereafter = jest.fn() as AnyMock;
const mockBuild = jest.fn() as AnyMock;
const mockSignTx = jest.fn() as AnyMock;
const mockSubmitTx = jest.fn() as AnyMock;

// The pre-submit hash guarantee is an ORDERING property: build → sign →
// resolve hash, with the broadcast deferred until the caller invokes
// `submit()`. "Was called" assertions alone would pass even if the builder
// regressed to submitting eagerly, so the order is recorded explicitly.
const callOrder: string[] = [];

const constructorCalls: unknown[] = [];

class FakeTransaction {
	txBuilder = {
		invalidBefore: (...args: unknown[]) => {
			callOrder.push('invalidBefore');
			return mockInvalidBefore(...args);
		},
		invalidHereafter: (...args: unknown[]) => {
			callOrder.push('invalidHereafter');
			return mockInvalidHereafter(...args);
		},
	};

	constructor(options: unknown) {
		constructorCalls.push(options);
	}

	setMetadata(...args: unknown[]): this {
		mockSetMetadata(...args);
		return this;
	}

	sendAssets(...args: unknown[]): this {
		mockSendAssets(...args);
		return this;
	}

	setNetwork(...args: unknown[]): this {
		mockSetNetwork(...args);
		return this;
	}

	build(...args: unknown[]): unknown {
		callOrder.push('build');
		return mockBuild(...args);
	}
}

jest.unstable_mockModule('@/generated/prisma/client', () => ({
	Network: { Mainnet: 'Mainnet', Preprod: 'Preprod' },
}));

jest.unstable_mockModule('@/utils/converter/network-convert', () => ({
	convertNetwork: mockConvertNetwork,
}));

jest.unstable_mockModule('@/utils/generator/wallet-generator', () => ({
	generateWalletExtended: mockGenerateWalletExtended,
}));

jest.unstable_mockModule('@/services/shared', () => ({
	Transaction: FakeTransaction,
}));

jest.unstable_mockModule('@/services/shared/tx-window', () => ({
	createTxWindow: mockCreateTxWindow,
}));

jest.unstable_mockModule('@meshsdk/core', () => ({
	resolveTxHash: mockResolveTxHash,
}));

let buildAndSignFundDistributionTx: typeof import('./transaction-builder').buildAndSignFundDistributionTx;

beforeAll(async () => {
	({ buildAndSignFundDistributionTx } = await import('./transaction-builder'));
});

const wallet = {
	signTx: (...args: unknown[]) => {
		callOrder.push('signTx');
		return mockSignTx(...args);
	},
	submitTx: (...args: unknown[]) => {
		callOrder.push('submitTx');
		return mockSubmitTx(...args);
	},
};
const blockchainProvider = { tag: 'provider' };

// Above Number.MAX_SAFE_INTEGER: proves lovelace amounts reach mesh as exact
// BigInt-derived strings, never routed through a lossy Number.
const HUGE_LOVELACE = 9_007_199_254_740_993n;

const baseParams = {
	encryptedMnemonic: 'enc-mnemonic',
	network: 'Preprod' as never,
	rpcProviderApiKey: 'rpc-key',
	outputs: [
		{ address: 'addr_target_1', assets: [{ unit: 'lovelace', quantity: 20_000_000n }] },
		{ address: 'addr_target_2', assets: [{ unit: 'lovelace', quantity: HUGE_LOVELACE }] },
	],
};

beforeEach(() => {
	jest.clearAllMocks();
	callOrder.length = 0;
	constructorCalls.length = 0;

	mockGenerateWalletExtended.mockResolvedValue({ wallet, blockchainProvider });
	mockConvertNetwork.mockReturnValue('preprod');
	mockCreateTxWindow.mockReturnValue({ invalidBefore: 1_000, invalidAfter: 1_330 });
	mockBuild.mockResolvedValue('unsigned-cbor');
	mockSignTx.mockResolvedValue('signed-cbor');
	mockResolveTxHash.mockReturnValue('a'.repeat(64));
	mockSubmitTx.mockResolvedValue('node-hash');
});

describe('buildAndSignFundDistributionTx', () => {
	it('derives the wallet from the encrypted mnemonic and wires it as initiator and fetcher', async () => {
		await buildAndSignFundDistributionTx(baseParams);

		expect(mockGenerateWalletExtended).toHaveBeenCalledWith('Preprod', 'rpc-key', 'enc-mnemonic');
		expect(constructorCalls).toEqual([{ initiator: wallet, fetcher: blockchainProvider }]);
		expect(mockSetMetadata).toHaveBeenCalledWith(674, { msg: ['Masumi', 'FundDistribution'] });
	});

	it('adds one exact-string output per target, surviving amounts beyond Number precision', async () => {
		await buildAndSignFundDistributionTx(baseParams);

		expect(mockSendAssets.mock.calls).toEqual([
			['addr_target_1', [{ unit: 'lovelace', quantity: '20000000' }]],
			['addr_target_2', [{ unit: 'lovelace', quantity: '9007199254740993' }]],
		]);
	});

	it('sends a token and its min-UTxO ADA as ONE output', async () => {
		await buildAndSignFundDistributionTx({
			...baseParams,
			outputs: [
				{
					address: 'addr_target_1',
					assets: [
						{ unit: 'lovelace', quantity: 2_000_000n },
						{ unit: `${'a'.repeat(56)}0014df105553444d`, quantity: 25_000_000n },
					],
				},
			],
		});

		// One sendAssets call, not two: a second output to the same address would
		// need its own min-UTxO ADA and hand the target two UTxOs.
		expect(mockSendAssets.mock.calls).toEqual([
			[
				'addr_target_1',
				[
					{ unit: 'lovelace', quantity: '2000000' },
					{ unit: `${'a'.repeat(56)}0014df105553444d`, quantity: '25000000' },
				],
			],
		]);
	});

	it('wires the shared tx window into the builder and reports its invalidAfter as the TTL', async () => {
		const result = await buildAndSignFundDistributionTx(baseParams);

		expect(mockConvertNetwork).toHaveBeenCalledWith('Preprod');
		expect(mockCreateTxWindow).toHaveBeenCalledWith('preprod');
		expect(mockSetNetwork).toHaveBeenCalledWith('preprod');
		expect(mockInvalidBefore).toHaveBeenCalledWith(1_000);
		expect(mockInvalidHereafter).toHaveBeenCalledWith(1_330);
		// The persisted TTL and the on-body TTL must be the SAME slot: the revert
		// path proves "can never land" against the stored value.
		expect(result.invalidHereafterSlot).toBe(1_330);
		expect(callOrder.indexOf('invalidHereafter')).toBeLessThan(callOrder.indexOf('build'));
	});

	it('resolves the intended hash from the SIGNED body and never broadcasts on its own', async () => {
		const result = await buildAndSignFundDistributionTx(baseParams);

		expect(mockSignTx).toHaveBeenCalledWith('unsigned-cbor');
		// Hashing the unsigned body would produce a hash the chain never shows,
		// making every ambiguous submit unresolvable.
		expect(mockResolveTxHash).toHaveBeenCalledWith('signed-cbor');
		expect(result.intendedTxHash).toBe('a'.repeat(64));
		expect(result.signedTx).toBe('signed-cbor');
		expect(callOrder).toEqual(['invalidBefore', 'invalidHereafter', 'build', 'signTx']);
		expect(mockSubmitTx).not.toHaveBeenCalled();
	});

	it('submit() broadcasts the signed body and returns the node hash', async () => {
		const result = await buildAndSignFundDistributionTx(baseParams);

		await expect(result.submit()).resolves.toBe('node-hash');
		expect(mockSubmitTx).toHaveBeenCalledWith('signed-cbor');
	});

	it('propagates build failures without touching submit', async () => {
		mockBuild.mockRejectedValue(new Error('UTxO Balance Insufficient'));

		await expect(buildAndSignFundDistributionTx(baseParams)).rejects.toThrow('UTxO Balance Insufficient');
		expect(mockSignTx).not.toHaveBeenCalled();
		expect(mockSubmitTx).not.toHaveBeenCalled();
	});
});
