import { jest } from '@jest/globals';
import type { Mock } from 'jest-mock';

type AnyMock = Mock<(...args: any[]) => any>;

const mockGenerateWalletExtended = jest.fn() as AnyMock;
const mockConvertNetwork = jest.fn() as AnyMock;
const mockCreateTxWindow = jest.fn() as AnyMock;
const mockResolveTxHash = jest.fn() as AnyMock;
const mockGetOutputMinLovelace = jest.fn() as AnyMock;
const mockFetchProtocolParameters = jest.fn() as AnyMock;
const mockProtocolParams = jest.fn() as AnyMock;

const mockSendAssets = jest.fn() as AnyMock;
const mockSetMetadata = jest.fn() as AnyMock;
const mockSetNetwork = jest.fn() as AnyMock;
const mockInvalidBefore = jest.fn() as AnyMock;
const mockInvalidHereafter = jest.fn() as AnyMock;
const mockBuild = jest.fn() as AnyMock;
const mockSignTx = jest.fn() as AnyMock;
const mockSubmitTx = jest.fn() as AnyMock;

// The pre-submit hash guarantee is an ORDERING property: build → sign → resolve
// hash, with broadcast deferred until the caller invokes submit(). "Was called"
// assertions alone would pass even if the builder regressed to eager submit.
const callOrder: string[] = [];
const constructorCalls: unknown[] = [];

class FakeTransaction {
	txBuilder = {
		protocolParams: mockProtocolParams,
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

jest.unstable_mockModule('@/utils/converter/network-convert', () => ({ convertNetwork: mockConvertNetwork }));

jest.unstable_mockModule('@/utils/generator/wallet-generator', () => ({
	generateWalletExtended: mockGenerateWalletExtended,
}));

jest.unstable_mockModule('@/services/shared', () => ({
	Transaction: FakeTransaction,
	createTxWindow: mockCreateTxWindow,
}));

jest.unstable_mockModule('@meshsdk/core', () => ({
	resolveTxHash: mockResolveTxHash,
	getOutputMinLovelace: mockGetOutputMinLovelace,
}));

let buildAndSignFundTransferTx: typeof import('./transaction-builder').buildAndSignFundTransferTx;

beforeAll(async () => {
	({ buildAndSignFundTransferTx } = await import('./transaction-builder'));
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
const blockchainProvider = { tag: 'provider', fetchProtocolParameters: mockFetchProtocolParameters };

// Above Number.MAX_SAFE_INTEGER: proves amounts reach mesh as exact
// BigInt-derived strings, never routed through a lossy Number.
const HUGE_LOVELACE = 9_007_199_254_740_993n;
const USDM = `${'a'.repeat(56)}55534424`;

const baseParams = {
	encryptedMnemonic: 'enc-mnemonic',
	network: 'Preprod' as never,
	rpcProviderApiKey: 'rpc-key',
	toAddress: 'addr_dest',
	assets: [
		{ unit: 'lovelace', quantity: HUGE_LOVELACE },
		{ unit: USDM, quantity: 25_000_000n },
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
	mockFetchProtocolParameters.mockResolvedValue({ coinsPerUtxoSize: 4310 });
	mockGetOutputMinLovelace.mockReturnValue(3_254_050n);
});

describe('buildAndSignFundTransferTx', () => {
	it('rejects token output below its live minimum before building or signing', async () => {
		await expect(
			buildAndSignFundTransferTx({
				...baseParams,
				assets: [
					{ unit: 'lovelace', quantity: 2_000_000n },
					...Array.from({ length: 8 }, (_, i) => ({
						unit: i.toString(16).padStart(56, '0') + 'ab'.repeat(32),
						quantity: 1n,
					})),
				],
			}),
		).rejects.toThrow('Transfer output requires at least 3254050 lovelace; requested 2000000');
		expect(mockBuild).not.toHaveBeenCalled();
		expect(mockSignTx).not.toHaveBeenCalled();
		expect(mockSubmitTx).not.toHaveBeenCalled();
	});

	it('uses the same live protocol parameters for validation and construction', async () => {
		await buildAndSignFundTransferTx(baseParams);
		expect(mockFetchProtocolParameters).toHaveBeenCalledWith(Number.NaN);
		expect(mockGetOutputMinLovelace).toHaveBeenCalledWith(
			{
				address: baseParams.toAddress,
				amount: baseParams.assets.map((asset) => ({ unit: asset.unit, quantity: asset.quantity.toString() })),
			},
			4310,
		);
		expect(mockProtocolParams).toHaveBeenCalledWith({ coinsPerUtxoSize: 4310 });
	});

	it('derives the wallet from the mnemonic and tags the tx as a fund transfer', async () => {
		await buildAndSignFundTransferTx(baseParams);
		expect(mockGenerateWalletExtended).toHaveBeenCalledWith('Preprod', 'rpc-key', 'enc-mnemonic');
		expect(constructorCalls).toEqual([{ initiator: wallet, fetcher: blockchainProvider }]);
		expect(mockSetMetadata).toHaveBeenCalledWith(674, { msg: ['Masumi', 'FundTransfer'] });
	});

	it('sends ADA and tokens as ONE output with exact string amounts', async () => {
		await buildAndSignFundTransferTx(baseParams);
		expect(mockSendAssets.mock.calls).toEqual([
			[
				'addr_dest',
				[
					{ unit: 'lovelace', quantity: '9007199254740993' },
					{ unit: USDM, quantity: '25000000' },
				],
			],
		]);
	});

	it('wires the shared tx window and reports invalidAfter as the TTL, before build', async () => {
		const result = await buildAndSignFundTransferTx(baseParams);
		expect(mockCreateTxWindow).toHaveBeenCalledWith('preprod');
		expect(mockSetNetwork).toHaveBeenCalledWith('preprod');
		expect(mockInvalidBefore).toHaveBeenCalledWith(1_000);
		expect(mockInvalidHereafter).toHaveBeenCalledWith(1_330);
		expect(result.invalidHereafterSlot).toBe(1_330);
		expect(callOrder.indexOf('invalidHereafter')).toBeLessThan(callOrder.indexOf('build'));
	});

	it('resolves the intended hash from the SIGNED body and never broadcasts on its own', async () => {
		const result = await buildAndSignFundTransferTx(baseParams);
		expect(mockSignTx).toHaveBeenCalledWith('unsigned-cbor');
		expect(mockResolveTxHash).toHaveBeenCalledWith('signed-cbor');
		expect(result.intendedTxHash).toBe('a'.repeat(64));
		expect(callOrder).toEqual(['invalidBefore', 'invalidHereafter', 'build', 'signTx']);
		expect(mockSubmitTx).not.toHaveBeenCalled();
	});

	it('submit() broadcasts the signed body and returns the node hash', async () => {
		const result = await buildAndSignFundTransferTx(baseParams);
		await expect(result.submit()).resolves.toBe('node-hash');
		expect(mockSubmitTx).toHaveBeenCalledWith('signed-cbor');
	});

	it('propagates build failures without touching submit', async () => {
		mockBuild.mockRejectedValue(new Error('UTxO Balance Insufficient'));
		await expect(buildAndSignFundTransferTx(baseParams)).rejects.toThrow('UTxO Balance Insufficient');
		expect(mockSignTx).not.toHaveBeenCalled();
		expect(mockSubmitTx).not.toHaveBeenCalled();
	});
	it.each([undefined, 0, -1, NaN, 1.5])('rejects invalid byte cost %s before signing', async (coinsPerUtxoSize) => {
		mockFetchProtocolParameters.mockResolvedValue({ coinsPerUtxoSize });
		await expect(buildAndSignFundTransferTx(baseParams)).rejects.toThrow('invalid coinsPerUtxoSize');
		expect(mockBuild).not.toHaveBeenCalled();
		expect(mockSignTx).not.toHaveBeenCalled();
	});
});
