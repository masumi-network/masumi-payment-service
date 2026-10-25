import { beforeEach, expect, it, jest } from '@jest/globals';
import type { UTxO } from '@meshsdk/core';

const participant = jest.fn<() => Promise<object>>();
const utxos = jest.fn<() => Promise<UTxO[]>>();
const addressUtxos = jest.fn<
	(
		address: string,
		pagination: { count: number; page: number; order: 'asc' | 'desc' },
	) => Promise<
		Array<{
			tx_hash: string;
			output_index: number;
			address: string;
			amount: Array<{ unit: string; quantity: string }>;
		}>
	>
>();
const history = jest.fn<() => Promise<Array<{ tx_hash: string }>>>();
const confirmation = jest.fn<(params: { txHash: string; requiredConfirmations: number }) => Promise<string>>();
const complete = jest.fn<() => Promise<string>>();
const fetchProtocolParameters =
	jest.fn<() => Promise<{ coinsPerUtxoSize: number; minFeeA: number; minFeeB: number }>>();
const protocolParams = jest.fn();
const submit = jest.fn<() => Promise<string>>();
const txIn = jest.fn();
const config = { BLOCK_CONFIRMATIONS_THRESHOLD: 0 };
const builder = {
	txIn,
	protocolParams: (params: object) => {
		protocolParams(params);
		return builder;
	},
	changeAddress: () => builder,
	setNetwork: () => builder,
	complete,
};

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
jest.unstable_mockModule('@masumi/payment-core/config', () => ({ CONFIG: config }));
jest.unstable_mockModule('@/utils/security/encryption', () => ({ decrypt: (value: string) => value }));
jest.unstable_mockModule('./node-address', () => ({ nodeCardanoAddress: () => 'node-address' }));
jest.unstable_mockModule('./service', () => ({ recentlySentTo: () => ({}) }));
jest.unstable_mockModule('@/utils/mesh-cost-model-sync', () => ({
	getCachedBlockfrostProvider: () => ({ fetchAddressUTxOs: utxos, fetchProtocolParameters }),
}));
jest.unstable_mockModule('@/utils/blockfrost', () => ({
	getBlockfrostInstance: () => ({ addressesTransactions: history, addressesUtxos: addressUtxos }),
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

const { KEY_RELEASE_MIN_CONFIRMATIONS, withdrawNodeFunds } = await import('./withdraw');
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
	addressUtxos.mockReset();
	config.BLOCK_CONFIRMATIONS_THRESHOLD = 0;
	participant.mockResolvedValue(storedParticipant);
	utxos.mockResolvedValue([]);
	addressUtxos.mockImplementation(async (_address, { page }) =>
		page === 1
			? (await utxos()).map((utxo) => ({
					tx_hash: utxo.input.txHash,
					output_index: utxo.input.outputIndex,
					...utxo.output,
				}))
			: [],
	);
	history.mockResolvedValue([{ tx_hash: 'a'.repeat(64) }]);
	confirmation.mockResolvedValue('confirmed-valid');
	complete.mockReset().mockResolvedValue('unsigned');
	fetchProtocolParameters.mockReset().mockResolvedValue({ coinsPerUtxoSize: 4310, minFeeA: 44, minFeeB: 155381 });
	submit.mockResolvedValue('a'.repeat(64));
});

it('sweeps native assets below the ADA dust floor with their entire input value', async () => {
	utxos.mockResolvedValue([tokenUtxo]);
	expect((await withdrawNodeFunds('participant')).code).toBe('swept');
	expect(txIn).toHaveBeenCalledWith(tokenUtxo.input.txHash, 0, tokenUtxo.output.amount, 'node-address');
});

it('does not report token-bearing dust as settled if its sweep cannot pay fees', async () => {
	utxos.mockResolvedValue([tokenUtxo]);
	complete.mockRejectedValueOnce(new Error('InputSelectionError: UTxO Fully Depleted'));
	expect(await withdrawNodeFunds('participant')).toMatchObject({
		code: 'insufficient-funds',
		balanceLovelace: '1500000',
		reason: expect.stringMatching(/add ADA.*retry/i),
	});
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

it('allows dust cleanup only at key-release depth even when the sync threshold is 0', async () => {
	expect((await withdrawNodeFunds('participant')).code).toBe('dust');
	expect(confirmation).toHaveBeenCalledWith(
		expect.objectContaining({
			txHash: 'a'.repeat(64),
			requiredConfirmations: KEY_RELEASE_MIN_CONFIRMATIONS,
		}),
	);
});

it('uses a configured threshold deeper than the key-release floor', async () => {
	config.BLOCK_CONFIRMATIONS_THRESHOLD = KEY_RELEASE_MIN_CONFIRMATIONS + 5;
	await withdrawNodeFunds('participant');
	expect(confirmation).toHaveBeenCalledWith(
		expect.objectContaining({ requiredConfirmations: KEY_RELEASE_MIN_CONFIRMATIONS + 5 }),
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

it.each([403, 429, 500, 503])(
	'retains the signer when the UTxO inventory fails with HTTP %i despite confirmed history',
	async (status) => {
		addressUtxos.mockRejectedValueOnce({ status_code: status });
		expect((await withdrawNodeFunds('participant')).code).toBe('chain-unreadable');
		expect(submit).not.toHaveBeenCalled();
	},
);

it('retains the signer when the UTxO inventory times out despite confirmed history', async () => {
	addressUtxos.mockRejectedValueOnce(new Error('request timed out'));
	expect((await withdrawNodeFunds('participant')).code).toBe('chain-unreadable');
	expect(submit).not.toHaveBeenCalled();
});

function inventoryPage(count: number, offset = 0) {
	return Array.from({ length: count }, (_, index) => ({
		tx_hash: 'b'.repeat(64),
		output_index: offset + index,
		address: 'node-address',
		amount: [{ unit: 'lovelace', quantity: '3000000' }],
	}));
}

it.each([404, 503])('retains the signer when a later inventory page fails with HTTP %i', async (status) => {
	addressUtxos.mockResolvedValueOnce(inventoryPage(100)).mockRejectedValueOnce({ status_code: status });
	expect((await withdrawNodeFunds('participant')).code).toBe('chain-unreadable');
	expect(submit).not.toHaveBeenCalled();
});

it('sweeps every input only after the entire paginated inventory has been read', async () => {
	addressUtxos.mockResolvedValueOnce(inventoryPage(100)).mockResolvedValueOnce(inventoryPage(1, 100));
	expect(await withdrawNodeFunds('participant')).toMatchObject({ code: 'swept', balanceLovelace: '303000000' });
	expect(addressUtxos).toHaveBeenNthCalledWith(1, 'node-address', { count: 100, page: 1, order: 'asc' });
	expect(addressUtxos).toHaveBeenNthCalledWith(2, 'node-address', { count: 100, page: 2, order: 'asc' });
	expect(txIn).toHaveBeenCalledTimes(101);
	expect(txIn).toHaveBeenLastCalledWith(
		'b'.repeat(64),
		100,
		[{ unit: 'lovelace', quantity: '3000000' }],
		'node-address',
	);
});

it('checks history before accepting an initial UTxO 404 as an unused address', async () => {
	addressUtxos.mockRejectedValueOnce({ status_code: 404 });
	history.mockRejectedValueOnce({ status_code: 404 });
	expect((await withdrawNodeFunds('participant')).code).toBe('dust');
	expect(addressUtxos).toHaveBeenCalledTimes(1);
	expect(history).toHaveBeenCalled();
});

it.each(['1200000', '1500000', '2000000'])(
	'attempts an ADA-only sweep of %s lovelace instead of releasing its signer',
	async (quantity) => {
		utxos.mockResolvedValue([
			{ ...tokenUtxo, output: { ...tokenUtxo.output, amount: [{ unit: 'lovelace', quantity }] } },
		]);
		expect((await withdrawNodeFunds('participant')).code).toBe('swept');
		expect(protocolParams).toHaveBeenCalledWith({ coinsPerUtxoSize: 4310, minFeeA: 44, minFeeB: 155381 });
	},
);

it('retains nonempty inventory when the builder reports insufficient ADA', async () => {
	utxos.mockResolvedValue([
		{ ...tokenUtxo, output: { ...tokenUtxo.output, amount: [{ unit: 'lovelace', quantity: '1000000' }] } },
	]);
	complete.mockRejectedValueOnce(new Error('InputSelectionError: UTxO Fully Depleted'));
	expect(await withdrawNodeFunds('participant')).toMatchObject({
		code: 'insufficient-funds',
		balanceLovelace: '1000000',
		reason: expect.stringMatching(/add ADA.*retry/i),
	});
	expect(submit).not.toHaveBeenCalled();
});

it('does not classify an unrelated build failure as insufficient funds', async () => {
	utxos.mockResolvedValue([tokenUtxo]);
	complete.mockRejectedValueOnce(new Error('invalid transaction encoding'));
	await expect(withdrawNodeFunds('participant')).rejects.toThrow('invalid transaction encoding');
	expect(submit).not.toHaveBeenCalled();
});

it('retains the signer when current protocol parameters cannot be read', async () => {
	utxos.mockResolvedValue([tokenUtxo]);
	fetchProtocolParameters.mockRejectedValueOnce(new Error('provider outage'));
	expect((await withdrawNodeFunds('participant')).code).toBe('chain-unreadable');
	expect(complete).not.toHaveBeenCalled();
	expect(submit).not.toHaveBeenCalled();
});

it.each([undefined, 0, -1, Number.NaN])('retains the signer when current minimum-output cost is %s', async (value) => {
	utxos.mockResolvedValue([tokenUtxo]);
	fetchProtocolParameters.mockResolvedValueOnce({ coinsPerUtxoSize: value as number, minFeeA: 44, minFeeB: 155381 });
	expect((await withdrawNodeFunds('participant')).code).toBe('chain-unreadable');
	expect(complete).not.toHaveBeenCalled();
	expect(submit).not.toHaveBeenCalled();
});
