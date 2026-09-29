import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const ADA = 1_000_000n;
const config = {
	EXCHAIN_COSIGN_URL: 'https://cosign.example' as string | null,
	EXCHAIN_NODE_TOKEN: 'token' as string | null,
	EXCHAIN_NODE_ID: 'node',
	EXCHAIN_ORG_ID: 'org',
};
const mockFetchWalletUtxo = jest.fn<(..._args: unknown[]) => Promise<unknown>>();
const mockReadWalletDatum = jest.fn<(..._args: unknown[]) => unknown>();

jest.unstable_mockModule('@masumi/payment-core/config', () => ({
	CONFIG: config,
	SERVICE_CONSTANTS: {
		TRANSACTION: { timeBufferMs: 300_000, blockTimeBufferMs: 60_000, validitySlotBuffer: 30, resultTimeSlotBuffer: 18 },
	},
}));
jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../../../smart-wallet/wallet-lifecycle', () => ({
	fetchWalletUtxo: mockFetchWalletUtxo,
	readWalletDatum: mockReadWalletDatum,
}));

const { guardedWalletAmounts } = await import('./guarded-packing');

function lovelaceValue(quantity: bigint) {
	return new Map([['', new Map([['', quantity]])]]);
}

const agentUtxos = [
	{
		input: { txHash: 'a'.repeat(64), outputIndex: 0 },
		output: { address: 'addr_test1agent', amount: [{ unit: 'lovelace', quantity: (10n * ADA).toString() }] },
	},
];
const params = {
	guarded: {
		hotWalletId: 'hw-1',
		scriptAddress: 'addr_test1script',
		policyId: 'p',
		stateTokenName: 't',
	} as never,
	network: 'preprod',
	rpcApiKey: 'preprodKey',
	agentUtxos,
	overheadLovelace: 3n * ADA,
};

function datum(spent: bigint) {
	return {
		agent: 'a'.repeat(56),
		limit: lovelaceValue(50n * ADA),
		// A period that has not ended, whatever the clock says.
		periodStart: BigInt(Date.now()),
		periodLength: 86_400_000n,
		spentInPeriod: lovelaceValue(spent),
		minBalanceLovelace: 0n,
	};
}

beforeEach(() => {
	jest.clearAllMocks();
	config.EXCHAIN_COSIGN_URL = 'https://cosign.example';
	mockFetchWalletUtxo.mockResolvedValue({
		input: { txHash: 'c'.repeat(64), outputIndex: 0 },
		output: { address: 'addr_test1script', amount: [{ unit: 'lovelace', quantity: (200n * ADA).toString() }] },
	});
	mockReadWalletDatum.mockReturnValue(datum(0n));
});

describe('guardedWalletAmounts', () => {
	it('offers the period budget plus the batch overhead', async () => {
		await expect(guardedWalletAmounts(params)).resolves.toEqual([{ unit: '', quantity: 53n * ADA }]);
	});

	it('is unknown, not empty, when the smart wallet cannot be read', async () => {
		mockFetchWalletUtxo.mockRejectedValue(new Error('Blockfrost 429'));
		await expect(guardedWalletAmounts(params)).resolves.toBeNull();
	});

	it('is unknown while the period budget is spent, because it resets', async () => {
		mockReadWalletDatum.mockReturnValue(datum(50n * ADA));
		await expect(guardedWalletAmounts(params)).resolves.toBeNull();
	});

	it('takes no purchase while co-signing is not configured', async () => {
		config.EXCHAIN_COSIGN_URL = null;
		await expect(guardedWalletAmounts(params)).resolves.toBeNull();
		expect(mockFetchWalletUtxo).not.toHaveBeenCalled();
	});
});
