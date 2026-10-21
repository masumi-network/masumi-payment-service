import { afterAll, afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
	Credential,
	EnterpriseAddress,
	FixedTransaction,
	PrivateKey,
	ScriptHash,
} from '@emurgo/cardano-serialization-lib-nodejs';
import { DEFAULT_PROTOCOL_PARAMETERS, MeshWallet, type UTxO } from '@meshsdk/core';
import { generateBlockchainIdentifier } from '@masumi/payment-core/blockchain-identifier';
import { encrypt } from '@/utils/security/encryption';

const mockPrismaTransaction = jest.fn<(..._args: unknown[]) => Promise<unknown>>();
const mockGetProvider = jest.fn<(..._args: unknown[]) => unknown>();

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: { $transaction: mockPrismaTransaction },
}));
jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('@/services/hydra-connection-manager/hydra-connection-manager.service', () => ({
	getHydraConnectionManager: () => ({ getProvider: mockGetProvider }),
}));

const { executeL2Lock } = await import('./l2-lock-execute');
type LockArgs = Parameters<typeof executeL2Lock>;

/**
 * Jest runs Mesh in a VM context, but its `structuredClone` is Node's, so the
 * Map it returns fails Mesh's `instanceof Map` once the builder clones its
 * metadata ("metadatumToObj: Unsupported Metadatum type"). Production has one
 * realm. This rebuilds a clone's Maps, and the arrays and objects that hold
 * them, in this realm.
 */
function rebuildInThisRealm(value: unknown): unknown {
	const tag = Object.prototype.toString.call(value);
	if (tag === '[object Map]') {
		return new Map(
			[...(value as Map<unknown, unknown>)].map(([key, entry]) => [rebuildInThisRealm(key), rebuildInThisRealm(entry)]),
		);
	}
	if (Array.isArray(value)) return value.map(rebuildInThisRealm);
	if (tag === '[object Object]') {
		return Object.fromEntries(Object.entries(value as object).map(([key, entry]) => [key, rebuildInThisRealm(entry)]));
	}
	return value;
}
const nodeStructuredClone = globalThis.structuredClone;
globalThis.structuredClone = ((value: unknown) =>
	rebuildInThisRealm(nodeStructuredClone(value))) as typeof structuredClone;
afterAll(() => {
	globalThis.structuredClone = nodeStructuredClone;
});

const TEST_MNEMONIC = (MeshWallet.brew(false) as string[]).join(' ');
const SELLER_ADDRESS =
	'addr_test1qp6ctf8vcjxzd53et7p0hlqyncn59stnfd4g8mp978v33r6dlzjvt4s2t6wn3v993pu9aea4h3z0jeyn6lsvw6hugtesfx55dd';
const SCRIPT_ADDRESS = EnterpriseAddress.new(0, Credential.from_scripthash(ScriptHash.from_bytes(Buffer.alloc(28, 9))))
	.to_address()
	.to_bech32();
const HOUR_MS = 60 * 60 * 1000;
/**
 * A head on a smaller limit than the shipped one. The check must use the head's
 * own limit: that head would refuse a lock between the two only after the
 * reservation.
 */
const HEAD_MAX_TX_SIZE = 12_000;

const mockSubmitTx = jest.fn<(cbor: string) => Promise<string>>();

/** A head whose clock is fresh and whose buyer wallet holds one 100 ADA UTxO. */
function fakeHead() {
	return {
		getHeadClock: () => ({ chainTimeMs: Date.now(), receivedAtMs: Date.now() }),
		fetchProtocolParameters: async () => ({ ...DEFAULT_PROTOCOL_PARAMETERS, maxTxSize: HEAD_MAX_TX_SIZE }),
		getPendingIncrementUtxoRefs: () => new Set<string>(),
		fetchAddressUTxOs: async (address: string): Promise<UTxO[]> => [
			{
				input: { txHash: 'a'.repeat(64), outputIndex: 0 },
				output: { address, amount: [{ unit: 'lovelace', quantity: '100000000' }] },
			},
		],
		submitTx: mockSubmitTx,
	};
}

function lockArgs(): LockArgs {
	const now = BigInt(Date.now());
	const request = {
		id: 'purchase-1',
		nextActionId: 'action-1',
		currentTransactionId: null,
		layer: null,
		smartContractWalletId: null,
		collateralReturnLovelace: null,
		buyerReturnAddress: null,
		sellerReturnAddress: null,
		blockchainIdentifier: generateBlockchainIdentifier(
			'01'.repeat(32),
			'02'.repeat(16),
			'03'.repeat(32),
			'04'.repeat(16),
		),
		inputHash: 'cd'.repeat(32),
		payByTime: now + BigInt(HOUR_MS),
		submitResultTime: now + BigInt(2 * HOUR_MS),
		unlockTime: now + BigInt(3 * HOUR_MS),
		externalDisputeUnlockTime: now + BigInt(4 * HOUR_MS),
		PaidFunds: [{ unit: '', amount: 10_000_000n }],
		SellerWallet: { walletAddress: SELLER_ADDRESS },
	};
	const paymentSource = { network: 'Preprod', smartContractAddress: SCRIPT_ADDRESS };
	const hotWallet = { id: 'wallet-1', collectionAddress: null, Secret: { encryptedMnemonic: encrypt(TEST_MNEMONIC) } };
	return [request, paymentSource, hotWallet, 'head-1'] as unknown as LockArgs;
}

beforeEach(() => {
	jest.clearAllMocks();
	mockGetProvider.mockReturnValue(fakeHead());
	mockPrismaTransaction.mockRejectedValue(new Error('reservation reached'));
	// Mesh warns that the head has no fetchCostModels and uses its defaults, as in production.
	jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
	jest.restoreAllMocks();
});

/**
 * Sign for real, then add `count` vkey witnesses. Mesh keeps the body it builds
 * under `maxTxSize`, so witnesses it did not plan for are what can push a signed
 * lock past the limit.
 */
function signWithExtraWitnesses(count: number): void {
	const signTx = MeshWallet.prototype.signTx;
	jest.spyOn(MeshWallet.prototype, 'signTx').mockImplementation(async function (
		this: MeshWallet,
		...args: Parameters<MeshWallet['signTx']>
	) {
		const transaction = FixedTransaction.from_hex(await signTx.apply(this, args));
		for (let index = 0; index < count; index += 1) {
			transaction.sign_and_add_vkey_signature(PrivateKey.generate_ed25519());
		}
		return transaction.to_hex();
	});
}

/**
 * The lock must refuse an oversized tx before it reserves anything. Past the
 * reservation, the head's refusal at submit reads as an ambiguous outcome, and
 * the buyer's reservation is held fail-closed until reconciliation.
 */
describe('executeL2Lock size check', () => {
	it('refuses a lock above the head limit before the reservation and the submit', async () => {
		// About 12,900 bytes signed: above this head's limit, below the shipped one.
		signWithExtraWitnesses(120);

		await expect(executeL2Lock(...lockArgs())).rejects.toThrow(`above the ${HEAD_MAX_TX_SIZE}-byte L2 limit`);
		expect(mockPrismaTransaction).not.toHaveBeenCalled();
		expect(mockSubmitTx).not.toHaveBeenCalled();
	});

	// Without this, a check that refused every lock would pass the test above.
	it('lets a lock within the limit reach the reservation', async () => {
		await expect(executeL2Lock(...lockArgs())).rejects.toThrow('reservation reached');
		expect(mockPrismaTransaction).toHaveBeenCalledTimes(1);
	});
});
