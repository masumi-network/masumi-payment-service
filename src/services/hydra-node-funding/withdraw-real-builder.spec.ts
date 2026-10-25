import { beforeEach, expect, it, jest } from '@jest/globals';
import { DEFAULT_PROTOCOL_PARAMETERS, getOutputMinLovelace, resolveTxHash, type UTxO } from '@meshsdk/core';
import { Transaction, PrivateKey, EnterpriseAddress, Credential } from '@emurgo/cardano-serialization-lib-nodejs';

const NODE_SIGNING_KEY = '5820' + '11'.repeat(32);
const NODE_KEY_HASH = PrivateKey.from_normal_bytes(Buffer.from(NODE_SIGNING_KEY.slice(4), 'hex'))
	.to_public()
	.hash();
const NODE_ADDRESS = EnterpriseAddress.new(0, Credential.from_keyhash(NODE_KEY_HASH)).to_address().to_bech32();
const FUNDING_ADDRESS =
	'addr_test1qq0e6dy7cehm9zfqurcf8mwwg9te9nszsx5gy5q4eclpd0czhmdlpagxe5n8ppnrf6424tt8gwweumrtg2q7234x2p2qzjenfx';
const INPUT_HASH = 'cd'.repeat(32);
let quantity: string;
let protocol = { ...DEFAULT_PROTOCOL_PARAMETERS };
const input = (): UTxO => ({
	input: { txHash: INPUT_HASH, outputIndex: 0 },
	output: { address: NODE_ADDRESS, amount: [{ unit: 'lovelace', quantity }] },
});
const submitTx = jest.fn<(signedTx: string) => Promise<string>>();
const provider = {
	fetchUTxOs: async () => [input()],
	fetchProtocolParameters: async () => protocol,
	submitTx,
};

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		hydraLocalParticipant: {
			findUniqueOrThrow: async () => ({
				id: 'participant',
				hostNodeId: 'node',
				hydraHostId: 'host',
				hydraHeadId: null,
				HydraHead: null,
				HydraSecretKey: { cardanoSK: NODE_SIGNING_KEY },
				cardanoVkey: NODE_KEY_HASH.to_hex(),
				Wallet: {
					walletAddress: FUNDING_ADDRESS,
					PaymentSource: { network: 'Preprod', PaymentSourceConfig: { rpcProviderApiKey: 'test' } },
				},
			}),
		},
		hydraHeadInvite: { findFirst: async () => null },
		walletFundTransfer: { findFirst: async () => null },
	},
}));
jest.unstable_mockModule('@masumi/payment-core/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn() } }));
jest.unstable_mockModule('@masumi/payment-core/config', () => ({ CONFIG: { BLOCK_CONFIRMATIONS_THRESHOLD: 0 } }));
jest.unstable_mockModule('@/utils/security/encryption', () => ({ decrypt: (value: string) => value }));
jest.unstable_mockModule('./node-address', () => ({ nodeCardanoAddress: () => NODE_ADDRESS }));
jest.unstable_mockModule('./service', () => ({ recentlySentTo: () => ({}) }));
jest.unstable_mockModule('@/utils/mesh-cost-model-sync', () => ({ getCachedBlockfrostProvider: () => provider }));
jest.unstable_mockModule('@/utils/blockfrost', () => ({
	getBlockfrostInstance: () => ({
		addressesUtxos: async () => [{ tx_hash: INPUT_HASH, output_index: 0, ...input().output }],
		addressesTransactions: async () => [{ tx_hash: INPUT_HASH }],
	}),
}));
jest.unstable_mockModule('@/services/shared/chain-tx-lookup', () => ({
	lookupConfirmedChainTx: async () => 'confirmed-valid',
	getChainErrorStatus: () => undefined,
}));

const { withdrawNodeFunds } = await import('./withdraw');
beforeEach(() => {
	jest.clearAllMocks();
	quantity = '1500000';
	protocol = { ...DEFAULT_PROTOCOL_PARAMETERS };
	submitTx.mockImplementation(async (signedTx) => String(resolveTxHash(signedTx)));
});

it.each(['1200000', '1500000', '2000000'])('builds and signs a real sweep for %s lovelace', async (amount) => {
	quantity = amount;
	const result = await withdrawNodeFunds('participant');
	expect(result.code).toBe('swept');
	const transaction = Transaction.from_hex(submitTx.mock.calls[0]![0]);
	const body = transaction.body();
	expect(body.inputs().len()).toBe(1);
	expect(body.inputs().get(0).transaction_id().to_hex()).toBe(INPUT_HASH);
	expect(body.outputs().len()).toBe(1);
	expect(body.outputs().get(0).address().to_bech32()).toBe(FUNDING_ADDRESS);
	expect(BigInt(body.outputs().get(0).amount().coin().to_str()) + BigInt(body.fee().to_str())).toBe(BigInt(amount));
	expect(BigInt(body.outputs().get(0).amount().coin().to_str())).toBeGreaterThanOrEqual(
		getOutputMinLovelace(
			{
				address: FUNDING_ADDRESS,
				amount: [{ unit: 'lovelace', quantity: body.outputs().get(0).amount().coin().to_str() }],
			},
			protocol.coinsPerUtxoSize,
		),
	);
	expect(transaction.witness_set().vkeys()?.len()).toBe(1);
});

it('keeps an unsweepable nonzero balance when the real builder cannot fund minimum change', async () => {
	quantity = '1000000';
	expect(await withdrawNodeFunds('participant')).toMatchObject({
		code: 'insufficient-funds',
		balanceLovelace: quantity,
		reason: expect.stringMatching(/add ADA.*retry/i),
	});
	expect(submitTx).not.toHaveBeenCalled();
});

it('uses current minimum-output parameters when they make a previously sweepable balance insufficient', async () => {
	protocol.coinsPerUtxoSize *= 2;
	expect((await withdrawNodeFunds('participant')).code).toBe('insufficient-funds');
	expect(submitTx).not.toHaveBeenCalled();
});
