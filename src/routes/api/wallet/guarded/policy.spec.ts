import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Network } from '@/generated/prisma/client';

type AsyncFn = (...args: never[]) => Promise<unknown>;
const mockPrepare = jest.fn<(params: Record<string, unknown>) => Promise<unknown>>();
const mockLoad = jest.fn<AsyncFn>();
const mockNoOpenTransfer = jest.fn<AsyncFn>();
const mockIdle = jest.fn<AsyncFn>();

class PolicyUpdateRefusedError extends Error {}
class GuardedWalletNotOnL1Error extends Error {}

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('@masumi/payment-source-v2/smart-wallet/policy-update', () => ({
	PolicyUpdateRefusedError,
	prepareOwnerPolicyUpdate: mockPrepare,
}));
jest.unstable_mockModule('@masumi/payment-source-v2/smart-wallet/wallet-lifecycle', () => ({
	GuardedWalletNotOnL1Error,
}));
jest.unstable_mockModule('./hydra/transfers', () => ({
	loadGuardedHotWallet: mockLoad,
	assertNoOpenTransfer: mockNoOpenTransfer,
	assertHotWalletIdle: mockIdle,
}));

const { prepareGuardedPolicyUpdate } = await import('./policy');

const scope = { networkLimit: [Network.Preprod], walletScopeIds: null };
const guarded = {
	id: 'gw-1',
	scriptAddress: 'addr_test1script',
	policyId: 'c'.repeat(56),
	governedAsset: 'lovelace',
	exchainWalletId: 'wal_01M3P5ZM0EP8R4NCQWS7TBWZFZ',
};
const input = {
	hotWalletId: 'hw-1',
	limits: [{ unit: 'lovelace', amount: '50000000' }],
	deposit: [{ unit: 'lovelace', amount: '1000000' }],
};

beforeEach(() => {
	jest.clearAllMocks();
	mockLoad.mockResolvedValue({
		hotWallet: { id: 'hw-1', PaymentSource: { PaymentSourceConfig: { rpcProviderApiKey: 'key' } } },
		guarded,
		params: { network: 'preprod' },
	});
	mockNoOpenTransfer.mockResolvedValue(undefined);
	mockIdle.mockResolvedValue(undefined);
	mockPrepare.mockResolvedValue({
		unsignedTx: '84a4',
		txHash: 'e'.repeat(64),
		walletUtxoRef: `${'f'.repeat(64)}#0`,
		script: { address: guarded.scriptAddress, policyId: guarded.policyId },
	});
});

describe('prepareGuardedPolicyUpdate', () => {
	it('passes the payment asset and the Exchain registration to the builder', async () => {
		const result = await prepareGuardedPolicyUpdate(input, scope);
		expect(mockPrepare).toHaveBeenCalledWith(
			expect.objectContaining({
				governedAsset: 'lovelace',
				isRegisteredWithExchain: true,
				limits: [{ unit: 'lovelace', quantity: '50000000' }],
				deposit: [{ unit: 'lovelace', quantity: '1000000' }],
			}),
		);
		expect(result).toEqual({ unsignedTx: '84a4', txHash: 'e'.repeat(64), walletUtxoRef: `${'f'.repeat(64)}#0` });
	});

	it.each([
		['a refused request', new PolicyUpdateRefusedError('limits must list lovelace'), 400],
		['a wallet in a head', new GuardedWalletNotOnL1Error('no utxo'), 409],
		['a build failure', new Error('UTxO Balance Insufficient'), 409],
	])('maps %s to %s', async (_label, error, status) => {
		mockPrepare.mockRejectedValue(error);
		await expect(prepareGuardedPolicyUpdate(input, scope)).rejects.toMatchObject({ status });
	});

	it('refuses a script that no longer matches the attach record', async () => {
		mockPrepare.mockResolvedValue({ unsignedTx: '84', txHash: 'e', walletUtxoRef: 'r', script: { address: 'x' } });
		await expect(prepareGuardedPolicyUpdate(input, scope)).rejects.toMatchObject({ status: 409 });
	});

	it('does not build while a Hydra move is open', async () => {
		mockNoOpenTransfer.mockRejectedValue(Object.assign(new Error('open move'), { status: 409 }));
		await expect(prepareGuardedPolicyUpdate(input, scope)).rejects.toMatchObject({ status: 409 });
		expect(mockPrepare).not.toHaveBeenCalled();
	});
});
