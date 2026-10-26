import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import {
	Address,
	BigInt as CardanoBigInt,
	BigNum,
	ConstrPlutusData,
	Credential,
	Ed25519KeyHash,
	EnterpriseAddress,
	ExUnits,
	FixedTransaction,
	PlutusData,
	PlutusList,
	Redeemer,
	Redeemers,
	RedeemerTag,
	ScriptHash,
	Transaction,
	TransactionBody,
	TransactionHash,
	TransactionInput,
	TransactionInputs,
	TransactionOutput,
	TransactionOutputs,
	TransactionWitnessSet,
	Value,
} from '@emurgo/cardano-serialization-lib-nodejs';
import { resolveHydraDepositScriptHash } from '@/lib/hydra/hydra/commit-draft-validation';
import { findHydraDepositReference } from './deposit-evidence';

type AnyMock = Mock<(...args: any[]) => any>;

const mockTxsUtxos = jest.fn() as AnyMock;
const mockTxsCbor = jest.fn() as AnyMock;
const mockUpdateMany = jest.fn() as AnyMock;
const mockLookupConfirmedChainTx = jest.fn() as AnyMock;

jest.unstable_mockModule('@/services/shared/chain-tx-lookup', () => ({
	lookupConfirmedChainTx: mockLookupConfirmedChainTx,
}));
const mockFindMany = jest.fn() as AnyMock;
const testConfig = { BLOCK_CONFIRMATIONS_THRESHOLD: 0 };
jest.unstable_mockModule('@masumi/payment-core/config', () => ({ CONFIG: testConfig }));

jest.unstable_mockModule('@/utils/blockfrost', () => ({
	getBlockfrostInstance: () => ({ txsUtxos: mockTxsUtxos, txsCbor: mockTxsCbor }),
}));

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: { hydraTopup: { updateMany: mockUpdateMany, findMany: mockFindMany } },
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { HydraTopupStatus } = await import('@/generated/prisma/client');
const { reconcileRecoveredHydraTopups } = await import('./recovered');
const { assertHydraDepositSettlementsFinal } = await import('./settlement-cleanup');

const HEAD_ID = 'aa'.repeat(28);
const SPENDER_TX = 'b'.repeat(64);
const SCRIPT_ADDRESS = EnterpriseAddress.new(0, Credential.from_scripthash(ScriptHash.from_hex('cc'.repeat(28))))
	.to_address()
	.to_bech32();
const WALLET = EnterpriseAddress.new(0, Credential.from_keyhash(Ed25519KeyHash.from_hex('dd'.repeat(28)))).to_address();
const WALLET_ADDRESS = WALLET.to_bech32();
const depositOutputs = TransactionOutputs.new();
const depositAddress = EnterpriseAddress.new(
	0,
	Credential.from_scripthash(ScriptHash.from_hex(resolveHydraDepositScriptHash())),
).to_address();
const depositOutput = TransactionOutput.new(depositAddress, Value.new(BigNum.from_str('3000000')));
const depositFields = PlutusList.new();
depositFields.add(PlutusData.new_bytes(Buffer.from(HEAD_ID, 'hex')));
depositFields.add(PlutusData.new_integer(CardanoBigInt.from_str('1')));
depositFields.add(PlutusData.new_list(PlutusList.new()));
depositOutput.set_plutus_data(PlutusData.new_constr_plutus_data(ConstrPlutusData.new(BigNum.zero(), depositFields)));
depositOutputs.add(depositOutput);
const DEPOSIT_CBOR = Transaction.new(
	TransactionBody.new(TransactionInputs.new(), depositOutputs, BigNum.zero()),
	TransactionWitnessSet.new(),
).to_hex();
const DEPOSIT_TX = FixedTransaction.from_hex(DEPOSIT_CBOR).transaction_hash().to_hex();

/** A row as the reconciler loads it, at whatever status the caller is testing. */
function topupRow(status: (typeof HydraTopupStatus)[keyof typeof HydraTopupStatus]) {
	return {
		id: 'topup-1',
		status,
		settlementTxHash: null as string | null,
		depositTxHash: DEPOSIT_TX,
		HydraHead: { headIdentifier: HEAD_ID },
		LocalParticipant: {
			Wallet: { PaymentSource: { network: 'Preprod', PaymentSourceConfig: { rpcProviderApiKey: 'preprodkey' } } },
		},
	};
}

/** The deposit's script output, and what the spending transaction paid to. */
function chain(
	consumedBy: string | null,
	spenderPaysTo: string[],
	options: { redeemer?: string; redeemerIndex?: number; unrelatedInput?: boolean; reportedSpender?: string } = {},
) {
	const inputs = TransactionInputs.new();
	inputs.add(TransactionInput.new(TransactionHash.from_hex(options.unrelatedInput ? 'ee'.repeat(32) : DEPOSIT_TX), 0));
	// Serialized first above, but canonically after this fuel input. Spend index 1
	// belongs to the deposit; a raw-body-index lookup would inspect the fuel.
	inputs.add(TransactionInput.new(TransactionHash.from_hex('00'.repeat(32)), 1));
	const outputs = TransactionOutputs.new();
	for (const address of spenderPaysTo) {
		outputs.add(TransactionOutput.new(Address.from_bech32(address), Value.new(BigNum.from_str('1'))));
	}
	const redeemers = Redeemers.new();
	redeemers.add(
		Redeemer.new(
			RedeemerTag.new_spend(),
			BigNum.from_str(String(options.redeemerIndex ?? 1)),
			PlutusData.from_hex(options.redeemer ?? (spenderPaysTo.includes(SCRIPT_ADDRESS) ? 'd87980' : 'd87a9f01ff')),
			ExUnits.new(BigNum.zero(), BigNum.zero()),
		),
	);
	const witnesses = TransactionWitnessSet.new();
	witnesses.set_redeemers(redeemers);
	const spenderCbor = Transaction.new(TransactionBody.new(inputs, outputs, BigNum.zero()), witnesses).to_hex();
	const spenderHash = FixedTransaction.from_hex(spenderCbor).transaction_hash().to_hex();
	mockTxsUtxos.mockImplementation(async (hash: string) => {
		if (hash === DEPOSIT_TX) {
			return {
				outputs: [
					{
						address: depositOutput.address().to_bech32(),
						output_index: 0,
						consumed_by_tx: consumedBy === null ? null : (options.reportedSpender ?? spenderHash),
					},
				],
			};
		}
		return { outputs: spenderPaysTo.map((address) => ({ address })) };
	});
	mockTxsCbor.mockImplementation(async (hash: string) => ({ cbor: hash === DEPOSIT_TX ? DEPOSIT_CBOR : spenderCbor }));
	return spenderHash;
}

/**
 * Separate Pending, terminal and Confirmed/Failed pools. Each row reaches only
 * the query whose status filter it matches, as it would in the database.
 */
function stageRows(rows: ReturnType<typeof topupRow>[]) {
	mockFindMany.mockImplementation(async (args: { where?: { status?: unknown } }) => {
		const status = args?.where?.status;
		if (status === HydraTopupStatus.Pending) {
			return rows.filter((row) => row.status === HydraTopupStatus.Pending);
		}
		if (typeof status === 'object' && status !== null && 'in' in status && Array.isArray(status.in)) {
			const statuses = status.in;
			return rows.filter((row) => statuses.includes(row.status));
		}
		return rows.filter((row) => row.status === HydraTopupStatus.Confirmed || row.status === HydraTopupStatus.Failed);
	});
}

beforeEach(() => {
	jest.clearAllMocks();
	mockUpdateMany.mockResolvedValue({ count: 1 });
	mockLookupConfirmedChainTx.mockResolvedValue('confirmed-valid');
});

describe('reconcileRecoveredHydraTopups', () => {
	it('recognizes Recover(1) despite unrelated trailing script change and a lower-sorting fuel input', async () => {
		stageRows([topupRow(HydraTopupStatus.Pending)]);
		chain(SPENDER_TX, [WALLET_ADDRESS, SCRIPT_ADDRESS], { redeemer: 'd87a9f01ff' });
		await reconcileRecoveredHydraTopups();
		expect(mockUpdateMany).toHaveBeenCalledWith({
			where: { id: 'topup-1', status: HydraTopupStatus.Pending, depositTxHash: DEPOSIT_TX, settlementTxHash: null },
			data: { status: HydraTopupStatus.Recovered, settlementTxHash: expect.any(String) },
		});
	});

	it.each([
		['an unbound CBOR hash', { reportedSpender: 'ff'.repeat(32) }],
		['an unknown deposit redeemer', { redeemer: 'd87b80' }],
		['a Claim carrying a field', { redeemer: 'd8799f01ff' }],
		['a Recover missing its integer', { redeemer: 'd87a80' }],
		['a Recover carrying bytes', { redeemer: 'd87a814100' }],
		['a Recover carrying extra fields', { redeemer: 'd87a820102' }],
		['a redeemer for the fuel input', { redeemerIndex: 0 }],
		['a spender with no deposit input', { unrelatedInput: true }],
	])('does not settle from %s', async (_label, options) => {
		stageRows([topupRow(HydraTopupStatus.Pending)]);
		chain(SPENDER_TX, [WALLET_ADDRESS], options);
		await reconcileRecoveredHydraTopups();
		expect(mockUpdateMany).toHaveBeenCalledWith({
			where: { id: 'topup-1', status: HydraTopupStatus.Pending, depositTxHash: DEPOSIT_TX, settlementTxHash: null },
			data: { updatedAt: expect.any(Date), settlementTxHash: null },
		});
	});

	it('corrects a historical Absorbed label when the exact deposit was recovered', async () => {
		stageRows([topupRow(HydraTopupStatus.Absorbed)]);
		chain(SPENDER_TX, [WALLET_ADDRESS, SCRIPT_ADDRESS], { redeemer: 'd87a9f01ff' });
		await reconcileRecoveredHydraTopups();
		expect(mockUpdateMany).toHaveBeenCalledWith({
			where: { id: 'topup-1', status: HydraTopupStatus.Absorbed, depositTxHash: DEPOSIT_TX, settlementTxHash: null },
			data: { status: HydraTopupStatus.Recovered, settlementTxHash: expect.any(String) },
		});
	});

	it('starts Pending lookups before historical terminal rechecks', async () => {
		const terminal = { ...topupRow(HydraTopupStatus.Absorbed), depositTxHash: 'ff'.repeat(32) };
		stageRows([terminal, topupRow(HydraTopupStatus.Pending)]);
		chain(SPENDER_TX, [WALLET_ADDRESS]);
		await reconcileRecoveredHydraTopups();
		expect(mockTxsCbor.mock.calls[0][0]).toBe(DEPOSIT_TX);
	});

	it('corrects a historical Recovered label from the exact Claim rather than output addresses', async () => {
		stageRows([topupRow(HydraTopupStatus.Recovered)]);
		chain(SPENDER_TX, [WALLET_ADDRESS], { redeemer: 'd87980' });
		await reconcileRecoveredHydraTopups();
		expect(mockUpdateMany).toHaveBeenCalledWith({
			where: { id: 'topup-1', status: HydraTopupStatus.Recovered, depositTxHash: DEPOSIT_TX, settlementTxHash: null },
			data: { status: HydraTopupStatus.Absorbed, settlementTxHash: expect.any(String) },
		});
	});

	it.each([HydraTopupStatus.Absorbed, HydraTopupStatus.Recovered])(
		'reopens a disproven %s label only after the exact deposit is confirmed unspent',
		async (status) => {
			stageRows([topupRow(status)]);
			chain(null, []);
			await reconcileRecoveredHydraTopups();
			expect(mockUpdateMany).toHaveBeenCalledWith({
				where: { id: 'topup-1', status, depositTxHash: DEPOSIT_TX, settlementTxHash: null },
				data: { status: HydraTopupStatus.Confirmed, settlementTxHash: null },
			});
		},
	);

	it('retains an old terminal label on transient evidence failure and rotates it for retry', async () => {
		stageRows([topupRow(HydraTopupStatus.Absorbed)]);
		mockTxsCbor.mockRejectedValueOnce(new Error('unavailable'));
		await reconcileRecoveredHydraTopups();
		expect(mockUpdateMany).toHaveBeenCalledWith({
			where: { id: 'topup-1', status: HydraTopupStatus.Absorbed, depositTxHash: DEPOSIT_TX, settlementTxHash: null },
			data: { updatedAt: expect.any(Date), settlementTxHash: null },
		});
	});

	it('does not settle a deposit bound to another head', async () => {
		const row = topupRow(HydraTopupStatus.Pending);
		row.HydraHead.headIdentifier = 'ff'.repeat(28);
		stageRows([row]);
		chain(SPENDER_TX, [WALLET_ADDRESS]);
		await reconcileRecoveredHydraTopups();
		expect(mockUpdateMany).toHaveBeenCalledWith({
			where: { id: 'topup-1', status: HydraTopupStatus.Pending, depositTxHash: DEPOSIT_TX, settlementTxHash: null },
			data: { updatedAt: expect.any(Date), settlementTxHash: null },
		});
	});

	it('requires the original deposit CBOR to match the recorded transaction hash', async () => {
		stageRows([topupRow(HydraTopupStatus.Pending)]);
		chain(SPENDER_TX, [WALLET_ADDRESS]);
		const differentBody = TransactionBody.new(TransactionInputs.new(), depositOutputs, BigNum.from_str('1'));
		mockTxsCbor.mockResolvedValueOnce({ cbor: Transaction.new(differentBody, TransactionWitnessSet.new()).to_hex() });
		await reconcileRecoveredHydraTopups();
		expect(mockUpdateMany).toHaveBeenCalledWith({
			where: { id: 'topup-1', status: HydraTopupStatus.Pending, depositTxHash: DEPOSIT_TX, settlementTxHash: null },
			data: { updatedAt: expect.any(Date), settlementTxHash: null },
		});
	});

	it('rejects an unrelated script credential even when its datum names this head', () => {
		const output = TransactionOutput.new(Address.from_bech32(SCRIPT_ADDRESS), Value.new(BigNum.from_str('3000000')));
		output.set_plutus_data(depositOutput.plutus_data()!);
		const outputs = TransactionOutputs.new();
		outputs.add(output);
		const cborHex = Transaction.new(
			TransactionBody.new(TransactionInputs.new(), outputs, BigNum.zero()),
			TransactionWitnessSet.new(),
		).to_hex();
		expect(
			findHydraDepositReference({
				cborHex,
				txHash: FixedTransaction.from_hex(cborHex).transaction_hash().to_hex(),
				headIdentifier: HEAD_ID,
				networkId: 0,
			}),
		).toBeNull();
	});
	/**
	 * The head folds a deposit in on its own schedule, without waiting for the
	 * confirmation threshold that promotes a row to Confirmed. Considering only
	 * Confirmed rows left a deposit reading "Pending" while its funds were
	 * already spendable on L2.
	 */
	it('marks a still-Pending deposit Absorbed once the head has taken it in', async () => {
		stageRows([topupRow(HydraTopupStatus.Pending)]);
		chain(SPENDER_TX, [SCRIPT_ADDRESS, WALLET_ADDRESS]);

		await reconcileRecoveredHydraTopups();

		expect(mockUpdateMany).toHaveBeenCalledWith({
			where: { id: 'topup-1', status: HydraTopupStatus.Pending, depositTxHash: DEPOSIT_TX, settlementTxHash: null },
			data: { status: HydraTopupStatus.Absorbed, settlementTxHash: expect.any(String) },
		});
	});

	it('queries Pending and settled rows separately, so neither starves the other', async () => {
		mockFindMany.mockResolvedValue([]);

		await reconcileRecoveredHydraTopups();

		const wheres = mockFindMany.mock.calls.map((call) => call[0]?.where);
		// One query for Pending on its own, one for Confirmed and Failed together,
		// each with its own take rather than a shared budget the larger pool wins.
		expect(wheres.map((where) => where?.status)).toContainEqual(HydraTopupStatus.Pending);
		const settled = wheres.find((where) => where?.OR !== undefined);
		expect(settled.OR).toContainEqual({ status: HydraTopupStatus.Confirmed });
		expect(settled.OR.map((filter: { status: string }) => filter.status)).toContain(HydraTopupStatus.Failed);
	});

	// A Failed deposit never landed (or landed invalid), so it can never come
	// back recovered or absorbed. Read forever, it logs a lookup failure on every
	// tick. It is checked only for a short window past its TTL.
	it('checks a Failed row only until shortly past its TTL, per network', async () => {
		mockFindMany.mockResolvedValue([]);
		const nowMs = Date.UTC(2026, 9, 12, 5, 30);
		const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(nowMs);

		try {
			await reconcileRecoveredHydraTopups();
		} finally {
			nowSpy.mockRestore();
		}

		const settled = mockFindMany.mock.calls.map((call) => call[0]?.where).find((where) => where?.OR !== undefined);
		const failed = settled.OR.filter((filter: { status: string }) => filter.status === HydraTopupStatus.Failed);
		// Shelley-era slot = zeroSlot + (unix seconds - zeroTime seconds), one-second slots.
		const windowStartSeconds = Math.floor((nowMs - 15 * 60 * 1000) / 1000);
		const cutoff = (network: 'mainnet' | 'preprod') =>
			network === 'mainnet'
				? BigInt(4_492_800 + windowStartSeconds - 1_596_059_091)
				: BigInt(86_400 + windowStartSeconds - 1_655_769_600);
		expect(failed).toEqual(
			expect.arrayContaining([
				{
					status: HydraTopupStatus.Failed,
					invalidHereafterSlot: { gte: cutoff('mainnet') },
					LocalParticipant: { Wallet: { PaymentSource: { network: 'Mainnet' } } },
				},
				{
					status: HydraTopupStatus.Failed,
					invalidHereafterSlot: { gte: cutoff('preprod') },
					LocalParticipant: { Wallet: { PaymentSource: { network: 'Preprod' } } },
				},
			]),
		);
		expect(failed).toHaveLength(2);
	});

	it('checks a Confirmed row even when the Pending pool is full', async () => {
		// The starvation this split prevents: a Confirmed deposit waiting to be
		// marked Absorbed must still be reached when many Pending rows are queued.
		const pending = Array.from({ length: 20 }, (_unused, index) => ({
			...topupRow(HydraTopupStatus.Pending),
			id: `pending-${index}`,
			depositTxHash: DEPOSIT_TX,
		}));
		const confirmed = { ...topupRow(HydraTopupStatus.Confirmed), id: 'confirmed-1' };
		stageRows([...pending, confirmed]);
		chain(SPENDER_TX, [SCRIPT_ADDRESS]);

		await reconcileRecoveredHydraTopups();

		expect(mockUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: 'confirmed-1',
					status: HydraTopupStatus.Confirmed,
					depositTxHash: DEPOSIT_TX,
					settlementTxHash: null,
				},
			}),
		);
	});

	it('marks a still-Pending deposit Recovered when it went back to a wallet', async () => {
		stageRows([topupRow(HydraTopupStatus.Pending)]);
		chain(SPENDER_TX, [WALLET_ADDRESS]);

		await reconcileRecoveredHydraTopups();

		expect(mockUpdateMany).toHaveBeenCalledWith({
			where: { id: 'topup-1', status: HydraTopupStatus.Pending, depositTxHash: DEPOSIT_TX, settlementTxHash: null },
			data: { status: HydraTopupStatus.Recovered, settlementTxHash: expect.any(String) },
		});
	});

	it('still absorbs from Confirmed, which was the only path before', async () => {
		stageRows([topupRow(HydraTopupStatus.Confirmed)]);
		chain(SPENDER_TX, [SCRIPT_ADDRESS]);

		await reconcileRecoveredHydraTopups();

		expect(mockUpdateMany).toHaveBeenCalledWith({
			where: { id: 'topup-1', status: HydraTopupStatus.Confirmed, depositTxHash: DEPOSIT_TX, settlementTxHash: null },
			data: { status: HydraTopupStatus.Absorbed, settlementTxHash: expect.any(String) },
		});
	});

	// Both reads are ordered by `updatedAt` and take a fixed budget, so a row that
	// never resolves would be re-read on every tick and nothing behind it would
	// ever be reached. The status is untouched — only the row's place in the
	// queue moves.
	it('leaves an unspent deposit alone, but rotates it to the back of the queue', async () => {
		stageRows([topupRow(HydraTopupStatus.Pending)]);
		chain(null, []);

		await reconcileRecoveredHydraTopups();

		expect(mockUpdateMany).toHaveBeenCalledTimes(1);
		expect(mockUpdateMany).toHaveBeenCalledWith({
			where: { id: 'topup-1', status: HydraTopupStatus.Pending, depositTxHash: DEPOSIT_TX, settlementTxHash: null },
			data: { updatedAt: expect.any(Date), settlementTxHash: null },
		});
	});

	// Failed was decided while the observer lagged; the deposit landed after all.
	// Left Failed, it would drop out of the recheck window before its spend.
	it('restores a Failed row to Confirmed when its deposit is on chain and unspent', async () => {
		stageRows([topupRow(HydraTopupStatus.Failed)]);
		chain(null, []);

		await reconcileRecoveredHydraTopups();

		expect(mockUpdateMany).toHaveBeenCalledTimes(1);
		expect(mockUpdateMany).toHaveBeenCalledWith({
			where: { id: 'topup-1', status: HydraTopupStatus.Failed, depositTxHash: DEPOSIT_TX, settlementTxHash: null },
			data: { status: HydraTopupStatus.Confirmed, settlementTxHash: null },
		});
	});

	// A shallow block can still roll back, and past its TTL the deposit could
	// not land again: the row would then sit in Confirmed with nothing to find.
	it('keeps a Failed row Failed until its deposit is confirmed deep enough', async () => {
		stageRows([topupRow(HydraTopupStatus.Failed)]);
		chain(null, []);
		mockLookupConfirmedChainTx.mockResolvedValue('pending');

		await reconcileRecoveredHydraTopups();

		// Only rotated to the back of the queue, so it cannot hold others back.
		expect(mockUpdateMany).toHaveBeenCalledTimes(1);
		expect(mockUpdateMany).toHaveBeenCalledWith({
			where: { id: 'topup-1', status: HydraTopupStatus.Failed, depositTxHash: DEPOSIT_TX, settlementTxHash: null },
			data: { updatedAt: expect.any(Date), settlementTxHash: null },
		});
	});

	it('leaves the row alone when the chain cannot be read', async () => {
		// A lookup failure is not evidence of anything, and guessing here would
		// declare funds home or absorbed on a network blip. The rotation still
		// happens: a row whose lookup keeps failing is exactly the one that would
		// otherwise hold the front of the queue forever.
		stageRows([topupRow(HydraTopupStatus.Pending)]);
		mockTxsUtxos.mockRejectedValue(new Error('blockfrost unavailable'));

		await reconcileRecoveredHydraTopups();

		expect(mockUpdateMany).toHaveBeenCalledTimes(1);
		expect(mockUpdateMany).toHaveBeenCalledWith({
			where: { id: 'topup-1', status: HydraTopupStatus.Pending, depositTxHash: DEPOSIT_TX, settlementTxHash: null },
			data: { updatedAt: expect.any(Date), settlementTxHash: null },
		});
	});

	it('guards the write on the status it read, so a concurrent promotion cannot be clobbered', async () => {
		stageRows([topupRow(HydraTopupStatus.Pending)]);
		chain(SPENDER_TX, [SCRIPT_ADDRESS]);
		mockUpdateMany.mockResolvedValue({ count: 0 });

		await reconcileRecoveredHydraTopups();

		expect(mockUpdateMany.mock.calls[0]?.[0]?.where?.status).toBe(HydraTopupStatus.Pending);
	});
});

describe('durable deposit settlement proof', () => {
	it.each(['pending', 'not-found', 'confirmed-invalid', 'transient-error'])(
		'refuses terminal promotion when the exact consumer is %s, despite a deep deposit',
		async (consumerResult) => {
			stageRows([topupRow(HydraTopupStatus.Pending)]);
			const spender = chain(SPENDER_TX, [WALLET_ADDRESS]);
			mockLookupConfirmedChainTx.mockImplementation(async ({ txHash }: { txHash: string }) =>
				txHash === DEPOSIT_TX ? 'confirmed-valid' : consumerResult,
			);
			await reconcileRecoveredHydraTopups();
			expect(mockLookupConfirmedChainTx).toHaveBeenCalledWith(
				expect.objectContaining({
					txHash: spender,
					requiredConfirmations: 20,
				}),
			);
			expect(mockUpdateMany.mock.calls.some(([args]) => args.data.status === HydraTopupStatus.Recovered)).toBe(false);
		},
	);

	it.each([0, 35])('records the exact consumer atomically at max(20, configured %s)', async (threshold) => {
		testConfig.BLOCK_CONFIRMATIONS_THRESHOLD = threshold;
		try {
			stageRows([topupRow(HydraTopupStatus.Recovered)]);
			const spender = chain(SPENDER_TX, [WALLET_ADDRESS]);
			await reconcileRecoveredHydraTopups();
			expect(mockLookupConfirmedChainTx).toHaveBeenCalledWith(
				expect.objectContaining({
					txHash: spender,
					requiredConfirmations: Math.max(20, threshold),
				}),
			);
			expect(mockUpdateMany).toHaveBeenCalledWith(
				expect.objectContaining({
					data: { status: HydraTopupStatus.Recovered, settlementTxHash: spender },
				}),
			);
		} finally {
			testConfig.BLOCK_CONFIRMATIONS_THRESHOLD = 0;
		}
	});

	it('invalidates a stored proof when the consumer is shallow after rollback', async () => {
		const row = topupRow(HydraTopupStatus.Absorbed);
		row.settlementTxHash = chain(SPENDER_TX, [SCRIPT_ADDRESS]);
		stageRows([row]);
		mockLookupConfirmedChainTx.mockResolvedValue('pending');
		await reconcileRecoveredHydraTopups();
		expect(mockUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ settlementTxHash: row.settlementTxHash }),
				data: expect.objectContaining({ settlementTxHash: null }),
			}),
		);
	});

	it('does not publish proof when the indexed consumer changes during finality observation', async () => {
		stageRows([topupRow(HydraTopupStatus.Pending)]);
		chain(SPENDER_TX, [WALLET_ADDRESS]);
		mockLookupConfirmedChainTx.mockImplementation(async () => {
			mockTxsUtxos.mockResolvedValue({
				outputs: [{ address: depositAddress.to_bech32(), output_index: 0, consumed_by_tx: null }],
			});
			return 'confirmed-valid';
		});
		await reconcileRecoveredHydraTopups();
		expect(mockUpdateMany.mock.calls.some(([args]) => args.data.status === HydraTopupStatus.Recovered)).toBe(false);
	});
});

describe('cleanup independently rechecks exact deposit proof', () => {
	it('allows a matching deep Claim proof without changing the record', async () => {
		const row = topupRow(HydraTopupStatus.Absorbed);
		row.settlementTxHash = chain(SPENDER_TX, [SCRIPT_ADDRESS]);
		stageRows([row]);
		await expect(assertHydraDepositSettlementsFinal(['head-1'])).resolves.toBeUndefined();
		expect(mockLookupConfirmedChainTx).toHaveBeenCalledWith(
			expect.objectContaining({
				txHash: row.settlementTxHash,
				requiredConfirmations: 20,
			}),
		);
		expect(mockUpdateMany).not.toHaveBeenCalled();
	});

	it.each(['pending', 'not-found', 'confirmed-invalid', 'transient-error'])(
		'refuses stored Recover proof with current consumer %s and clears permission by CAS',
		async (result) => {
			const row = topupRow(HydraTopupStatus.Recovered);
			row.settlementTxHash = chain(SPENDER_TX, [WALLET_ADDRESS]);
			stageRows([row]);
			mockLookupConfirmedChainTx.mockResolvedValue(result);
			await expect(assertHydraDepositSettlementsFinal(['head-1'])).rejects.toMatchObject({ statusCode: 409 });
			expect(mockUpdateMany).toHaveBeenCalledWith({
				where: { id: row.id, status: row.status, depositTxHash: DEPOSIT_TX, settlementTxHash: row.settlementTxHash },
				data: { settlementTxHash: null },
			});
		},
	);

	it('reopens a rolled-back Recover when the original exact deposit is confirmed unspent', async () => {
		const row = topupRow(HydraTopupStatus.Recovered);
		row.settlementTxHash = chain(SPENDER_TX, [WALLET_ADDRESS]);
		chain(null, []);
		stageRows([row]);
		await expect(assertHydraDepositSettlementsFinal(['head-1'])).rejects.toMatchObject({ statusCode: 409 });
		expect(mockUpdateMany).toHaveBeenCalledWith({
			where: { id: row.id, status: row.status, depositTxHash: DEPOSIT_TX, settlementTxHash: row.settlementTxHash },
			data: { status: HydraTopupStatus.Confirmed, settlementTxHash: null },
		});
	});

	it('refuses a different deep consumer until reconciliation truthfully repairs its proof', async () => {
		const row = topupRow(HydraTopupStatus.Recovered);
		row.settlementTxHash = 'ee'.repeat(32);
		chain(SPENDER_TX, [WALLET_ADDRESS]);
		stageRows([row]);
		await expect(assertHydraDepositSettlementsFinal(['head-1'])).rejects.toMatchObject({ statusCode: 409 });
		expect(mockUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { settlementTxHash: null } }));
	});
});
