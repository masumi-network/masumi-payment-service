import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
	Address,
	BigNum,
	Credential,
	EnterpriseAddress,
	FixedTransaction,
	PrivateKey,
	TransactionBody,
	TransactionHash,
	TransactionInput,
	TransactionInputs,
	TransactionOutput,
	TransactionOutputs,
	Value,
} from '@emurgo/cardano-serialization-lib-nodejs';
import {
	GuardedHydraTransferDirection,
	GuardedHydraTransferStatus,
	HydraHeadStatus,
	Network,
} from '@/generated/prisma/client';

type AsyncFn = (...args: unknown[]) => Promise<unknown>;
const mockTransferFindFirst = jest.fn<AsyncFn>();
const mockTransferFindUnique = jest.fn<AsyncFn>();
const mockTransferUpdate = jest.fn<AsyncFn>();
const mockTransferUpdateMany = jest.fn<AsyncFn>();
const mockTransferFindUniqueOrThrow = jest.fn<AsyncFn>();
const mockQueryRaw = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockHeadFindUnique = jest.fn<AsyncFn>();
const mockLoadHotWallet = jest.fn<AsyncFn>();
const mockGetHead = jest.fn<(id: string) => unknown>();

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		guardedHydraTransfer: {
			findFirst: mockTransferFindFirst,
			findUnique: mockTransferFindUnique,
			update: mockTransferUpdate,
			updateMany: mockTransferUpdateMany,
			findUniqueOrThrow: mockTransferFindUniqueOrThrow,
		},
		hydraHead: { findUnique: mockHeadFindUnique },
		$transaction: (run: (tx: unknown) => Promise<unknown>) =>
			run({
				$queryRaw: mockQueryRaw,
				guardedHydraTransfer: {
					findFirst: mockTransferFindFirst,
					updateMany: mockTransferUpdateMany,
					findUniqueOrThrow: mockTransferFindUniqueOrThrow,
				},
			}),
	},
}));
jest.unstable_mockModule('../service', () => ({ loadPurchasingHotWallet: mockLoadHotWallet }));
jest.unstable_mockModule('@/services/hydra-connection-manager/hydra-connection-manager.service', () => ({
	getHydraConnectionManager: () => ({ getHead: mockGetHead }),
}));

const { assertNoOpenTransfer, loadParticipantHead, loadTransferToSubmit, markTransferSubmitted } =
	await import('./transfers');

const OUTPUT_ADDRESS = 'addr_test1vz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzerspjrlsz';
const scope = { networkLimit: [Network.Preprod], walletScopeIds: null };

function unsignedTx(inputTxHash = '0'.repeat(64)): FixedTransaction {
	const inputs = TransactionInputs.new();
	inputs.add(TransactionInput.new(TransactionHash.from_hex(inputTxHash), 0));
	const outputs = TransactionOutputs.new();
	outputs.add(TransactionOutput.new(Address.from_bech32(OUTPUT_ADDRESS), Value.new(BigNum.from_str('2000000'))));
	const body = TransactionBody.new_tx_body(inputs, outputs, BigNum.from_str('170000'));
	return FixedTransaction.new_from_body_bytes(body.to_bytes());
}

function signed(tx: FixedTransaction, key: PrivateKey): string {
	tx.sign_and_add_vkey_signature(key);
	return tx.to_hex();
}

const owner = PrivateKey.generate_ed25519();
const ownerAddress = EnterpriseAddress.new(0, Credential.from_keyhash(owner.to_public().hash()))
	.to_address()
	.to_bech32();
const preparedTx = unsignedTx();
const preparedTxHash = preparedTx.transaction_hash().to_hex();

type TransferRow = {
	id: string;
	direction: GuardedHydraTransferDirection;
	status: GuardedHydraTransferStatus;
	txHash: string;
	signBefore: Date | null;
	GuardedWallet: { id: string; hotWalletId: string };
};

function transfer(overrides: Partial<TransferRow> = {}): TransferRow {
	return {
		id: 'transfer-1',
		direction: GuardedHydraTransferDirection.Deposit,
		status: GuardedHydraTransferStatus.Prepared,
		txHash: preparedTxHash,
		signBefore: new Date(Date.now() + 60_000),
		GuardedWallet: { id: 'gw-1', hotWalletId: 'hw-1' },
		...overrides,
	};
}

function hotWallet() {
	return {
		id: 'hw-1',
		GuardedWallet: {
			id: 'gw-1',
			ownerAddress,
			quorumVkhs: ['1'.repeat(56)],
			threshold: 1,
			stateTokenName: 'b'.repeat(64),
		},
		PaymentSource: { network: Network.Preprod },
	};
}

function submit(signedTx: string, direction: GuardedHydraTransferDirection = GuardedHydraTransferDirection.Deposit) {
	return loadTransferToSubmit({ transferId: 'transfer-1', direction, signedTx, scope });
}

beforeEach(() => {
	jest.clearAllMocks();
	mockLoadHotWallet.mockResolvedValue(hotWallet());
	mockTransferUpdate.mockResolvedValue({});
});

describe('assertNoOpenTransfer', () => {
	it('blocks Submitted and Prepared transfers with a live or null signBefore', async () => {
		mockTransferFindFirst.mockResolvedValue(null);
		const now = new Date('2026-10-12T10:00:00Z');
		await expect(assertNoOpenTransfer('gw-1', now)).resolves.toBeUndefined();
		expect(mockTransferFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					guardedWalletId: 'gw-1',
					OR: [
						{ status: GuardedHydraTransferStatus.Submitted },
						{
							status: GuardedHydraTransferStatus.Prepared,
							OR: [{ signBefore: null }, { signBefore: { gt: now } }],
						},
					],
				},
			}),
		);
	});

	it('throws 409 naming the open transfer', async () => {
		mockTransferFindFirst.mockResolvedValue({
			id: 'transfer-9',
			direction: GuardedHydraTransferDirection.Withdraw,
			status: GuardedHydraTransferStatus.Submitted,
		});
		await expect(assertNoOpenTransfer('gw-1')).rejects.toMatchObject({
			status: 409,
			message: expect.stringContaining('transfer-9'),
		});
	});
});

describe('loadTransferToSubmit', () => {
	it('returns 404 for an unknown transfer', async () => {
		mockTransferFindUnique.mockResolvedValue(null);
		await expect(submit(signed(unsignedTx(), owner))).rejects.toMatchObject({ status: 404 });
	});

	it('returns 404 for a transfer of the other direction', async () => {
		mockTransferFindUnique.mockResolvedValue(transfer());
		await expect(submit(signed(unsignedTx(), owner), GuardedHydraTransferDirection.Withdraw)).rejects.toMatchObject({
			status: 404,
		});
		expect(mockLoadHotWallet).not.toHaveBeenCalled();
	});

	it('returns 409 when the transfer is not Prepared', async () => {
		mockTransferFindUnique.mockResolvedValue(transfer({ status: GuardedHydraTransferStatus.Submitted }));
		await expect(submit(signed(unsignedTx(), owner))).rejects.toMatchObject({ status: 409 });
		expect(mockTransferUpdate).not.toHaveBeenCalled();
	});

	it('marks the transfer Expired and returns 409 when signBefore passed', async () => {
		mockTransferFindUnique.mockResolvedValue(transfer({ signBefore: new Date(Date.now() - 1_000) }));
		await expect(submit(signed(unsignedTx(), owner))).rejects.toMatchObject({ status: 409 });
		expect(mockTransferUpdate).toHaveBeenCalledWith({
			where: { id: 'transfer-1' },
			data: { status: GuardedHydraTransferStatus.Expired },
		});
	});

	it('returns 400 when the signed body differs from the prepared one', async () => {
		mockTransferFindUnique.mockResolvedValue(transfer());
		await expect(submit(signed(unsignedTx('1'.repeat(64)), owner))).rejects.toMatchObject({
			status: 400,
			message: 'signedTx changes the prepared transaction body',
		});
	});

	it('returns 400 when the owner witness is missing', async () => {
		mockTransferFindUnique.mockResolvedValue(transfer());
		await expect(submit(signed(unsignedTx(), PrivateKey.generate_ed25519()))).rejects.toMatchObject({
			status: 400,
			message: "signedTx lacks a valid witness from the wallet owner's key",
		});
	});

	it('returns 400 for bytes that are not a transaction', async () => {
		mockTransferFindUnique.mockResolvedValue(transfer());
		await expect(submit('deadbeef')).rejects.toMatchObject({ status: 400 });
	});

	it('returns the transfer when the owner signed the prepared body', async () => {
		const prepared = transfer({ signBefore: null });
		mockTransferFindUnique.mockResolvedValue(prepared);
		await expect(submit(signed(unsignedTx(), owner))).resolves.toBe(prepared);
		expect(mockLoadHotWallet).toHaveBeenCalledWith('hw-1', scope);
		expect(mockTransferUpdate).not.toHaveBeenCalled();
	});
});

describe('loadParticipantHead', () => {
	type HeadRow = {
		id: string;
		isEnabled: boolean;
		status: HydraHeadStatus;
		headIdentifier: string | null;
		LocalParticipant: { id: string; walletId: string } | null;
	};

	function head(overrides: Partial<HeadRow> = {}): HeadRow {
		return {
			id: 'head-1',
			isEnabled: true,
			status: HydraHeadStatus.Open,
			headIdentifier: 'head-identifier',
			LocalParticipant: { id: 'participant-1', walletId: 'hw-1' },
			...overrides,
		};
	}

	beforeEach(() => {
		mockGetHead.mockReturnValue({ id: 'connection' });
	});

	it('returns 404 for an unknown head', async () => {
		mockHeadFindUnique.mockResolvedValue(null);
		await expect(loadParticipantHead('head-1', 'hw-1')).rejects.toMatchObject({ status: 404 });
	});

	it.each<[string, Partial<HeadRow>]>([
		['disabled', { isEnabled: false }],
		['not Open', { status: HydraHeadStatus.Closed }],
		['without a head identifier', { headIdentifier: null }],
		['without a local participant', { LocalParticipant: null }],
		['of another local participant', { LocalParticipant: { id: 'participant-1', walletId: 'hw-2' } }],
	])('returns 409 for a head %s', async (_label, overrides) => {
		mockHeadFindUnique.mockResolvedValue(head(overrides));
		await expect(loadParticipantHead('head-1', 'hw-1')).rejects.toMatchObject({ status: 409 });
		expect(mockGetHead).not.toHaveBeenCalled();
	});

	it('returns 502 when no connection to the head exists', async () => {
		mockHeadFindUnique.mockResolvedValue(head());
		mockGetHead.mockReturnValue(undefined);
		await expect(loadParticipantHead('head-1', 'hw-1')).rejects.toMatchObject({ status: 502 });
	});

	it('returns the head, participant and connection', async () => {
		mockHeadFindUnique.mockResolvedValue(head());
		const result = await loadParticipantHead('head-1', 'hw-1');
		expect(result.head.headIdentifier).toBe('head-identifier');
		expect(result.participant).toEqual({ id: 'participant-1', walletId: 'hw-1' });
		expect(result.hydraHead).toEqual({ id: 'connection' });
		expect(mockGetHead).toHaveBeenCalledWith('head-1');
	});
});

describe('markTransferSubmitted', () => {
	const transfer = { id: 'tr-1', guardedWalletId: 'gw-1' };

	beforeEach(() => {
		jest.clearAllMocks();
		mockTransferFindFirst.mockResolvedValue(null);
		mockTransferUpdateMany.mockResolvedValue({ count: 1 });
		mockTransferFindUniqueOrThrow.mockResolvedValue({ id: 'tr-1', status: GuardedHydraTransferStatus.Submitted });
	});

	it('moves a Prepared transfer to Submitted exactly once', async () => {
		await expect(markTransferSubmitted(transfer)).resolves.toMatchObject({ id: 'tr-1' });
		expect(mockTransferUpdateMany).toHaveBeenCalledWith({
			where: { id: 'tr-1', status: GuardedHydraTransferStatus.Prepared },
			data: { status: GuardedHydraTransferStatus.Submitted, submittedAt: expect.any(Date) },
		});
		// The check and the write run under the wallet row lock.
		const [sql, walletId] = mockQueryRaw.mock.calls[0] as [TemplateStringsArray, string];
		expect(sql.join('?')).toContain('FOR UPDATE');
		expect(walletId).toBe('gw-1');
	});

	it('answers 409 when a concurrent submit already took it', async () => {
		mockTransferUpdateMany.mockResolvedValue({ count: 0 });
		await expect(markTransferSubmitted(transfer)).rejects.toMatchObject({ status: 409 });
	});

	it('answers 409 while another transfer of the wallet is submitted', async () => {
		mockTransferFindFirst.mockResolvedValue({ id: 'tr-other' });
		await expect(markTransferSubmitted(transfer)).rejects.toMatchObject({ status: 409 });
		expect(mockTransferUpdateMany).not.toHaveBeenCalled();
	});
});
