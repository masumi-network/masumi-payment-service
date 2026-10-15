import { beforeEach, expect, it, jest } from '@jest/globals';
import type { UTxO } from '@meshsdk/core';

const participant = jest.fn<() => Promise<object>>();
const utxos = jest.fn<() => Promise<UTxO[]>>();
const history = jest.fn<() => Promise<Array<{ tx_hash: string }>>>();
const confirmation = jest.fn<(params: { txHash: string; requiredConfirmations: number }) => Promise<string>>();
const complete = jest.fn<() => Promise<string>>();
const submit = jest.fn<() => Promise<string>>();
const txIn = jest.fn();
const builder = { txIn, changeAddress: () => builder, setNetwork: () => builder, complete };

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		hydraLocalParticipant: { findUniqueOrThrow: participant },
		hydraHeadInvite: { findFirst: async () => null },
		walletFundTransfer: { findFirst: async () => null },
	},
}));
jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn() },
}));
jest.unstable_mockModule('@/utils/security/encryption', () => ({ decrypt: (value: string) => value }));
jest.unstable_mockModule('./node-address', () => ({ nodeCardanoAddress: () => 'node-address' }));
jest.unstable_mockModule('./service', () => ({ recentlySentTo: () => ({}) }));
jest.unstable_mockModule('@/utils/mesh-cost-model-sync', () => ({
	getCachedBlockfrostProvider: () => ({ fetchAddressUTxOs: utxos }),
}));
jest.unstable_mockModule('@/utils/blockfrost', () => ({
	getBlockfrostInstance: () => ({ addressesTransactions: history }),
}));
jest.unstable_mockModule('@/services/shared/chain-tx-lookup', () => ({
	lookupConfirmedChainTx: confirmation,
	getChainErrorStatus: (error: { status_code?: number }) => error.status_code,
}));
jest.unstable_mockModule('@meshsdk/core', () => ({
	MeshTxBuilder: class {
		constructor() {
			return builder;
		}
	},
	MeshWallet: class {
		signTx = async () => 'signed';
		submitTx = submit;
	},
	resolveTxHash: () => 'a'.repeat(64),
}));

const { withdrawNodeFunds } = await import('./withdraw');
const storedParticipant = {
	id: 'participant',
	hostNodeId: 'node',
	hydraHostId: 'host',
	hydraHeadId: null,
	HydraHead: null,
	HydraSecretKey: { cardanoSK: 'signer' },
	cardanoVkey: 'vkey',
	Wallet: {
		walletAddress: 'funding-address',
		PaymentSource: {
			network: 'Preprod',
			PaymentSourceConfig: { rpcProviderApiKey: 'api-key' },
		},
	},
};
const tokenUtxo: UTxO = {
	input: { txHash: 'b'.repeat(64), outputIndex: 0 },
	output: {
		address: 'node-address',
		amount: [
			{ unit: 'lovelace', quantity: '1500000' },
			{ unit: 'c'.repeat(56), quantity: '1' },
		],
	},
};

beforeEach(() => {
	jest.clearAllMocks();
	participant.mockResolvedValue(storedParticipant);
	utxos.mockResolvedValue([]);
	history.mockResolvedValue([{ tx_hash: 'a'.repeat(64) }]);
	confirmation.mockResolvedValue('confirmed-valid');
	complete.mockResolvedValue('unsigned');
	submit.mockResolvedValue('a'.repeat(64));
});

it('sweeps native assets below the ADA dust floor with their entire input value', async () => {
	utxos.mockResolvedValue([tokenUtxo]);
	expect((await withdrawNodeFunds('participant')).code).toBe('swept');
	expect(txIn).toHaveBeenCalledWith(tokenUtxo.input.txHash, 0, tokenUtxo.output.amount, 'node-address');
});

it('does not report token-bearing dust as settled if its sweep cannot pay fees', async () => {
	utxos.mockResolvedValue([tokenUtxo]);
	complete.mockRejectedValueOnce(new Error('insufficient lovelace'));
	await expect(withdrawNodeFunds('participant')).rejects.toThrow('insufficient lovelace');
	expect(submit).not.toHaveBeenCalled();
});

it('retains a legacy signer when native assets remain below the ADA dust floor', async () => {
	participant.mockResolvedValue({ ...storedParticipant, HydraSecretKey: { cardanoSK: null } });
	utxos.mockResolvedValue([tokenUtxo]);
	expect((await withdrawNodeFunds('participant')).code).toBe('no-key');
});

it.each(['pending', 'not-found', 'transient-error', 'confirmed-invalid'])(
	'keeps the signer when the latest address transaction is %s despite an empty UTxO set',
	async (result) => {
		confirmation.mockResolvedValue(result);
		expect((await withdrawNodeFunds('participant')).code).not.toBe('dust');
	},
);

it('allows dust cleanup after the latest address transaction reaches configured depth', async () => {
	expect((await withdrawNodeFunds('participant')).code).toBe('dust');
	expect(confirmation).toHaveBeenCalledWith(
		expect.objectContaining({
			txHash: 'a'.repeat(64),
			requiredConfirmations: expect.any(Number),
		}),
	);
});

it('retains the signer when address history is unavailable', async () => {
	history.mockRejectedValueOnce({ status_code: 500 });
	expect((await withdrawNodeFunds('participant')).code).not.toBe('dust');
});

it('allows an unused address with no transaction history', async () => {
	history.mockRejectedValueOnce({ status_code: 404 });
	expect((await withdrawNodeFunds('participant')).code).toBe('dust');
});
