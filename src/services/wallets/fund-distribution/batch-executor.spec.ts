import { jest } from '@jest/globals';
import type { Mock } from 'jest-mock';

type AnyMock = Mock<(...args: any[]) => any>;

const mockBuildAndSign = jest.fn() as AnyMock;
const mockSubmit = jest.fn() as AnyMock;
const mockFetchAddressBalanceMap = jest.fn() as AnyMock;
const mockIsDefinitiveNodeRejection = jest.fn() as AnyMock;

const mockTxCreate = jest.fn() as AnyMock;
const mockTxUpdateMany = jest.fn() as AnyMock;
const mockTxDeleteMany = jest.fn() as AnyMock;
const mockHotWalletUpdateMany = jest.fn() as AnyMock;
const mockLowBalanceRuleUpdateMany = jest.fn() as AnyMock;
const mockRequestUpdateMany = jest.fn() as AnyMock;
const mockRequestCount = jest.fn() as AnyMock;
const mockPrismaTransaction = jest.fn() as AnyMock;

const mockQueueSent = jest.fn() as AnyMock;
const mockQueueFailed = jest.fn() as AnyMock;
const mockTriggerLowBalance = jest.fn() as AnyMock;

// Records the order in which the intended-hash write and the broadcast happen.
// The whole point of the pre-submit recording is that it precedes submitTx;
// asserting both merely "were called" would pass even if the order regressed.
const callOrder: string[] = [];

const HotWalletType = { Purchasing: 'Purchasing', Selling: 'Selling', Funding: 'Funding' } as const;
const FundDistributionStatus = {
	Pending: 'Pending',
	Submitted: 'Submitted',
	Confirmed: 'Confirmed',
	Failed: 'Failed',
} as const;
const TransactionStatus = { Pending: 'Pending', Confirmed: 'Confirmed', RolledBack: 'RolledBack' } as const;
const Network = { Mainnet: 'Mainnet', Preprod: 'Preprod' } as const;

jest.unstable_mockModule('@/generated/prisma/client', () => ({
	HotWalletType,
	FundDistributionStatus,
	TransactionStatus,
	Network,
	PaymentSourceType: { Web3CardanoV1: 'Web3CardanoV1', Web3CardanoV2: 'Web3CardanoV2' },
}));

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		$transaction: mockPrismaTransaction,
		fundDistributionRequest: { updateMany: mockRequestUpdateMany },
		hotWalletLowBalanceRule: { updateMany: mockLowBalanceRuleUpdateMany },
	},
}));

jest.unstable_mockModule('@masumi/payment-core/config', () => ({
	CONSTANTS: {
		MIN_TX_FEE_BUFFER_LOVELACE: 2_000_000n,
		FUND_DISTRIBUTION_MAX_OUTPUTS_PER_TX: 2,
		FUND_DISTRIBUTION_UNDERFUNDED_ALERT_COOLDOWN_MS: 900_000,
		FUND_DISTRIBUTION_TOKEN_OUTPUT_LOVELACE: 2_000_000n,
	},
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('@masumi/payment-core/blockchain-error-interpreter', () => ({
	interpretBlockchainError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

jest.unstable_mockModule('@masumi/payment-core/db-retry', () => ({
	retryOnSerializationConflict: async (fn: () => Promise<unknown>) => fn(),
}));

jest.unstable_mockModule('@masumi/payment-core/submit-error-classifier', () => ({
	isDefinitiveNodeRejection: mockIsDefinitiveNodeRejection,
}));

jest.unstable_mockModule('@/services/shared/address-balance', () => ({
	fetchAddressBalanceMap: mockFetchAddressBalanceMap,
}));

jest.unstable_mockModule('@/services/webhooks', () => ({
	webhookEventsService: {
		queueFundDistributionSent: mockQueueSent,
		queueFundDistributionFailed: mockQueueFailed,
		triggerWalletLowBalance: mockTriggerLowBalance,
	},
}));

jest.unstable_mockModule('./transaction-builder', () => ({
	buildAndSignFundDistributionTx: mockBuildAndSign,
}));

let processRequestsForFundWallet: typeof import('./batch-executor').processRequestsForFundWallet;

beforeAll(async () => {
	({ processRequestsForFundWallet } = await import('./batch-executor'));
});

const INTENDED_HASH = 'a'.repeat(64);

const fundWallet = {
	id: 'fund-1',
	walletAddress: 'addr_fund',
	walletVkey: 'vkey_fund',
	lowBalanceRules: new Map<string, { id: string; lastAlertedAt: Date | null }>([
		['lovelace', { id: 'rule-1', lastAlertedAt: null }],
	]),
	paymentSourceId: 'ps-1',
	paymentSourceType: 'Web3CardanoV1' as const,
	network: 'Preprod' as const,
	rpcProviderApiKey: 'key',
	encryptedMnemonic: 'enc',
	config: {
		batchWindowMs: 300_000,
		assets: new Map([
			[
				'lovelace',
				{
					assetUnit: 'lovelace',
					warningThreshold: 10_000_000n,
					criticalThreshold: 5_000_000n,
					topupAmount: 20_000_000n,
				},
			],
		]),
	},
};

const request = (id: string, amount: bigint, assetUnit = 'lovelace') => ({
	id,
	targetWalletId: `target-${id}`,
	targetAddress: `addr_${id}`,
	assetUnit,
	amount,
});

beforeEach(() => {
	jest.clearAllMocks();
	callOrder.length = 0;

	mockFetchAddressBalanceMap.mockResolvedValue(new Map([['lovelace', 100_000_000n]]));
	mockTxCreate.mockResolvedValue({ id: 'tx-1' });
	mockHotWalletUpdateMany.mockResolvedValue({ count: 1 });
	mockLowBalanceRuleUpdateMany.mockResolvedValue({ count: 1 });
	mockRequestUpdateMany.mockImplementation(async (args: any) => ({ count: args?.where?.id?.in?.length ?? 1 }));
	mockRequestCount.mockImplementation(async (args: any) => args?.where?.id?.in?.length ?? 0);
	mockTxUpdateMany.mockImplementation(async (args: any) => {
		if (args?.data?.intendedTxHash) callOrder.push('record-intended');
		if (args?.data?.txHash) callOrder.push('record-txhash');
		return { count: 1 };
	});
	mockTxDeleteMany.mockResolvedValue({ count: 1 });
	mockPrismaTransaction.mockImplementation(async (arg: unknown) => {
		if (typeof arg === 'function') {
			return (arg as (tx: unknown) => Promise<unknown>)({
				hotWallet: { updateMany: mockHotWalletUpdateMany },
				transaction: { create: mockTxCreate, updateMany: mockTxUpdateMany, deleteMany: mockTxDeleteMany },
				fundDistributionRequest: { updateMany: mockRequestUpdateMany, count: mockRequestCount },
			});
		}
		return Promise.all(arg as Promise<unknown>[]);
	});
	mockIsDefinitiveNodeRejection.mockReturnValue(false);

	mockSubmit.mockImplementation(async () => {
		callOrder.push('submit');
		return INTENDED_HASH;
	});
	mockBuildAndSign.mockResolvedValue({
		signedTx: 'signed',
		intendedTxHash: INTENDED_HASH,
		invalidHereafterSlot: 12345,
		submit: mockSubmit,
	});
});

describe('processRequestsForFundWallet', () => {
	it('records intendedTxHash BEFORE broadcasting', async () => {
		await processRequestsForFundWallet(fundWallet, [request('r1', 20_000_000n)]);

		expect(callOrder).toEqual(['record-intended', 'submit', 'record-txhash']);
		expect(mockTxUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ id: 'tx-1', intendedTxHash: null }),
				data: expect.objectContaining({ intendedTxHash: INTENDED_HASH, invalidHereafterSlot: 12345n }),
			}),
		);
	});

	it('marks requests Submitted and reports SENT on success', async () => {
		await processRequestsForFundWallet(fundWallet, [request('r1', 20_000_000n)]);

		expect(mockRequestUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ id: { in: ['r1'] } }),
				data: expect.objectContaining({ status: FundDistributionStatus.Submitted, txHash: INTENDED_HASH }),
			}),
		);
		expect(mockQueueSent).toHaveBeenCalledWith(
			expect.any(Object),
			expect.objectContaining({ txHash: INTENDED_HASH }),
			'ps-1',
		);
	});

	it('links the batch to its Transaction atomically with the lock', async () => {
		await processRequestsForFundWallet(fundWallet, [request('r1', 20_000_000n)]);

		// Without this link, reconciliation can resolve the Transaction but
		// nothing maps its verdict back onto the distribution rows.
		expect(mockRequestUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ transactionId: 'tx-1' }) }),
		);
	});

	describe('when submit is ambiguous', () => {
		beforeEach(() => {
			mockIsDefinitiveNodeRejection.mockReturnValue(false);
			mockSubmit.mockImplementation(async () => {
				callOrder.push('submit');
				throw new Error('socket hang up');
			});
		});

		it('leaves the requests Pending for reconciliation rather than failing them', async () => {
			await processRequestsForFundWallet(fundWallet, [request('r1', 20_000_000n)]);

			// The tx may well be on chain. Failing the requests here would let the
			// next cycle rebuild and re-send them -- paying the treasury twice.
			const statuses = mockRequestUpdateMany.mock.calls.map((call: any) => call[0]?.data?.status);
			expect(statuses).not.toContain(FundDistributionStatus.Failed);
		});

		it('does not unlock the wallet or delete the Transaction', async () => {
			await processRequestsForFundWallet(fundWallet, [request('r1', 20_000_000n)]);

			expect(mockTxDeleteMany).not.toHaveBeenCalled();
			expect(mockHotWalletUpdateMany).not.toHaveBeenCalledWith(
				expect.objectContaining({ data: expect.objectContaining({ lockedAt: null }) }),
			);
		});

		it('does not report an outcome yet', async () => {
			await processRequestsForFundWallet(fundWallet, [request('r1', 20_000_000n)]);

			// Still in flight: reconciliation decides, and the cycle reports then.
			expect(mockQueueFailed).not.toHaveBeenCalled();
			expect(mockQueueSent).not.toHaveBeenCalled();
		});
	});

	it('reverts and fails the batch when the node definitively rejects it', async () => {
		mockIsDefinitiveNodeRejection.mockReturnValue(true);
		mockSubmit.mockRejectedValue(new Error('BadInputsUTxO'));

		await processRequestsForFundWallet(fundWallet, [request('r1', 20_000_000n)]);

		// Definitively rejected means it cannot land, so reverting is safe.
		expect(mockTxDeleteMany).toHaveBeenCalledWith({
			where: { id: 'tx-1', status: TransactionStatus.Pending },
		});
		expect(mockRequestUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ status: FundDistributionStatus.Failed }) }),
		);
		expect(mockQueueFailed).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ txHash: null }), 'ps-1');
	});

	it('reverts when build/sign fails, without ever broadcasting', async () => {
		mockBuildAndSign.mockRejectedValue(new Error('insufficient balance'));

		await processRequestsForFundWallet(fundWallet, [request('r1', 20_000_000n)]);

		expect(mockSubmit).not.toHaveBeenCalled();
		expect(mockTxDeleteMany).toHaveBeenCalled();
		expect(mockQueueFailed).toHaveBeenCalledWith(
			expect.any(Object),
			expect.objectContaining({ txHash: null, error: 'insufficient balance' }),
			'ps-1',
		);
	});

	it('aborts without broadcasting if the intended hash cannot be persisted', async () => {
		mockTxUpdateMany.mockImplementation(async (args: any) => {
			if (args?.data?.intendedTxHash) throw new Error('db down');
			return { count: 1 };
		});

		await processRequestsForFundWallet(fundWallet, [request('r1', 20_000_000n)]);

		// Broadcasting without a recorded hash would make an ambiguous outcome
		// unrecoverable, so we must not send.
		expect(mockSubmit).not.toHaveBeenCalled();
		expect(mockTxDeleteMany).toHaveBeenCalled();
	});

	it('defers to reconciliation when the node returns a different hash', async () => {
		mockSubmit.mockResolvedValue('b'.repeat(64));

		await processRequestsForFundWallet(fundWallet, [request('r1', 20_000_000n)]);

		// Trust neither hash: do not record a txHash, do not mark Submitted.
		expect(mockTxUpdateMany).not.toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ txHash: expect.any(String) }) }),
		);
		const statuses = mockRequestUpdateMany.mock.calls.map((call: any) => call[0]?.data?.status);
		expect(statuses).not.toContain(FundDistributionStatus.Submitted);
	});

	it('skips when the fund wallet is already locked', async () => {
		mockHotWalletUpdateMany.mockResolvedValue({ count: 0 });

		await processRequestsForFundWallet(fundWallet, [request('r1', 20_000_000n)]);

		expect(mockBuildAndSign).not.toHaveBeenCalled();
	});

	it('abandons the batch when another worker already claimed one of its requests', async () => {
		mockRequestUpdateMany.mockResolvedValueOnce({ count: 0 });

		await processRequestsForFundWallet(fundWallet, [request('r1', 20_000_000n)]);

		expect(mockBuildAndSign).not.toHaveBeenCalled();
	});

	it('discards a signed body when timeout recovery has taken the wallet lease', async () => {
		mockHotWalletUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

		await processRequestsForFundWallet(fundWallet, [request('r1', 20_000_000n)]);

		expect(mockSubmit).not.toHaveBeenCalled();
		expect(mockTxUpdateMany).not.toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ intendedTxHash: INTENDED_HASH }) }),
		);
	});

	it('claims only enabled active sources and active target wallets', async () => {
		await processRequestsForFundWallet(fundWallet, [request('r1', 20_000_000n)]);

		expect(mockHotWalletUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					FundDistributionConfig: { enabled: true },
					PaymentSource: { deletedAt: null },
				}),
			}),
		);
		expect(mockRequestUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					TargetWallet: { deletedAt: null, PaymentSource: { deletedAt: null } },
				}),
			}),
		);
	});

	it('caps recipients and leaves overflow requests for a later transaction', async () => {
		await processRequestsForFundWallet(fundWallet, [
			request('r1', 20_000_000n),
			request('r2', 20_000_000n),
			request('r3', 20_000_000n),
		]);

		expect(mockBuildAndSign).toHaveBeenCalledWith(
			expect.objectContaining({
				outputs: [
					{ address: 'addr_r1', assets: [{ unit: 'lovelace', quantity: 20_000_000n }] },
					{ address: 'addr_r2', assets: [{ unit: 'lovelace', quantity: 20_000_000n }] },
				],
			}),
		);
	});

	it('only clears the lock owned by a pre-broadcast rollback', async () => {
		mockBuildAndSign.mockRejectedValue(new Error('build failed'));

		await processRequestsForFundWallet(fundWallet, [request('r1', 20_000_000n)]);

		expect(mockHotWalletUpdateMany).toHaveBeenCalledWith({
			where: { id: 'fund-1', pendingTransactionId: 'tx-1' },
			data: { lockedAt: null, pendingTransactionId: null },
		});
	});

	it('sends only the requests the balance covers', async () => {
		// 30 ADA balance - 2 ADA fee buffer = 28 ADA spendable: covers r1, not r2.
		mockFetchAddressBalanceMap.mockResolvedValue(new Map([['lovelace', 30_000_000n]]));

		await processRequestsForFundWallet(fundWallet, [request('r1', 20_000_000n), request('r2', 20_000_000n)]);

		expect(mockBuildAndSign).toHaveBeenCalledWith(
			expect.objectContaining({
				outputs: [{ address: 'addr_r1', assets: [{ unit: 'lovelace', quantity: 20_000_000n }] }],
			}),
		);
	});

	it('reports low balance and sends nothing when the fee buffer is not covered', async () => {
		mockFetchAddressBalanceMap.mockResolvedValue(new Map([['lovelace', 1_000_000n]]));

		await processRequestsForFundWallet(fundWallet, [request('r1', 20_000_000n)]);

		expect(mockBuildAndSign).not.toHaveBeenCalled();
		expect(mockTriggerLowBalance).toHaveBeenCalledWith(
			expect.objectContaining({ walletId: 'fund-1', walletType: HotWalletType.Funding, ruleId: 'rule-1' }),
		);
		// The lastAlertedAt claim is what throttles the per-cycle re-fire and
		// dedupes across replicas — the alert must ride on a won claim only.
		expect(mockLowBalanceRuleUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({ where: expect.objectContaining({ id: 'rule-1' }) }),
		);
	});

	it('reports low balance when the fee buffer is covered but no request is affordable', async () => {
		mockFetchAddressBalanceMap.mockResolvedValue(new Map([['lovelace', 10_000_000n]]));

		await processRequestsForFundWallet(fundWallet, [request('r1', 20_000_000n)]);

		expect(mockBuildAndSign).not.toHaveBeenCalled();
		expect(mockTriggerLowBalance).toHaveBeenCalledWith(
			expect.objectContaining({ walletId: 'fund-1', walletType: HotWalletType.Funding, ruleId: 'rule-1' }),
		);
	});

	it('skips the underfunded alert while the cooldown holds or without a rule', async () => {
		mockFetchAddressBalanceMap.mockResolvedValue(new Map([['lovelace', 1_000_000n]]));

		// Alerted moments ago → throttled before any DB write.
		await processRequestsForFundWallet(
			{ ...fundWallet, lowBalanceRules: new Map([['lovelace', { id: 'rule-1', lastAlertedAt: new Date() }]]) },
			[request('r1', 20_000_000n)],
		);
		expect(mockLowBalanceRuleUpdateMany).not.toHaveBeenCalled();
		expect(mockTriggerLowBalance).not.toHaveBeenCalled();

		// No rule → no webhook with a dangling ruleId.
		await processRequestsForFundWallet({ ...fundWallet, lowBalanceRules: new Map() }, [request('r1', 20_000_000n)]);
		expect(mockTriggerLowBalance).not.toHaveBeenCalled();

		// Another replica won the claim between our read and the write → it sends.
		mockLowBalanceRuleUpdateMany.mockResolvedValue({ count: 0 });
		await processRequestsForFundWallet(fundWallet, [request('r1', 20_000_000n)]);
		expect(mockTriggerLowBalance).not.toHaveBeenCalled();
	});

	it('reads the balance without decrypting the treasury mnemonic', async () => {
		await processRequestsForFundWallet(fundWallet, [request('r1', 20_000_000n)]);

		expect(mockFetchAddressBalanceMap).toHaveBeenCalledWith(
			expect.objectContaining({ address: 'addr_fund', network: 'Preprod' }),
		);
	});

	it('takes every claim at Serializable isolation', async () => {
		await processRequestsForFundWallet(fundWallet, [request('r1', 20_000_000n)]);

		// The whole claim model rests on this: the wallet claim, the request claim
		// and the ownership re-check are only atomic against a concurrent replica
		// under Serializable. A weaker level silently reintroduces the double-send
		// this design exists to prevent, and nothing else would notice.
		const isolationLevels = mockPrismaTransaction.mock.calls
			.filter((call: any[]) => typeof call[0] === 'function')
			.map((call: any[]) => call[1]?.isolationLevel);

		expect(isolationLevels.length).toBeGreaterThan(0);
		expect(isolationLevels.every((level: unknown) => level === 'Serializable')).toBe(true);
	});

	it('spends a balance that exactly covers a request', async () => {
		// 22 ADA - 2 ADA fee buffer = exactly 20 ADA spendable, for a 20 ADA
		// request. The boundary is the whole point: `<` instead of `<=` silently
		// refuses an affordable top-up and the wallet stays low forever.
		mockFetchAddressBalanceMap.mockResolvedValue(new Map([['lovelace', 22_000_000n]]));

		await processRequestsForFundWallet(fundWallet, [request('r1', 20_000_000n)]);

		expect(mockBuildAndSign).toHaveBeenCalledWith(
			expect.objectContaining({
				outputs: [{ address: 'addr_r1', assets: [{ unit: 'lovelace', quantity: 20_000_000n }] }],
			}),
		);
	});

	describe('native tokens', () => {
		const USDM = `${'c48cbb'.repeat(9)}dd0014df105553444d`;

		const withBalance = (lovelace: bigint, usdm: bigint) =>
			mockFetchAddressBalanceMap.mockResolvedValue(
				new Map([
					['lovelace', lovelace],
					[USDM, usdm],
				]),
			);

		it('attaches min-UTxO ADA to a token-only topup', async () => {
			withBalance(100_000_000n, 500_000_000n);

			await processRequestsForFundWallet(fundWallet, [request('r1', 250_000_000n, USDM)]);

			// A token output cannot exist without ADA. The operator asked for USDM
			// only; the lovelace floor is added at build time.
			expect(mockBuildAndSign).toHaveBeenCalledWith(
				expect.objectContaining({
					outputs: [
						{
							address: 'addr_r1',
							assets: [
								{ unit: USDM, quantity: 250_000_000n },
								{ unit: 'lovelace', quantity: 2_000_000n },
							],
						},
					],
				}),
			);
		});

		it('combines ADA and token for the same target into ONE output', async () => {
			withBalance(100_000_000n, 500_000_000n);

			await processRequestsForFundWallet(fundWallet, [
				{ id: 'r1', targetWalletId: 'w1', targetAddress: 'addr_w1', assetUnit: 'lovelace', amount: 20_000_000n },
				{ id: 'r2', targetWalletId: 'w1', targetAddress: 'addr_w1', assetUnit: USDM, amount: 250_000_000n },
			]);

			// Two outputs to one address would each need their own min-UTxO ADA and
			// hand the wallet two UTxOs. The requested 20 ADA already clears the
			// floor, so it is NOT added to — 22 ADA here would be a bug.
			expect(mockBuildAndSign).toHaveBeenCalledWith(
				expect.objectContaining({
					outputs: [
						{
							address: 'addr_w1',
							assets: [
								{ unit: 'lovelace', quantity: 20_000_000n },
								{ unit: USDM, quantity: 250_000_000n },
							],
						},
					],
				}),
			);
		});

		it('will not send a token the treasury does not hold, even with ADA to spare', async () => {
			withBalance(100_000_000n, 10_000_000n);

			await processRequestsForFundWallet(fundWallet, [request('r1', 250_000_000n, USDM)]);

			expect(mockBuildAndSign).not.toHaveBeenCalled();
		});

		it('names the short asset in the underfunded alert', async () => {
			withBalance(100_000_000n, 10_000_000n);
			const walletWithUsdmRule = {
				...fundWallet,
				lowBalanceRules: new Map([
					['lovelace', { id: 'rule-ada', lastAlertedAt: null }],
					[USDM, { id: 'rule-usdm', lastAlertedAt: null }],
				]),
			};

			await processRequestsForFundWallet(walletWithUsdmRule, [request('r1', 250_000_000n, USDM)]);

			// "Top up the treasury" is useless advice when the treasury is flush with
			// ADA and out of USDM. The alert has to say which.
			expect(mockTriggerLowBalance).toHaveBeenCalledWith(expect.objectContaining({ assetUnit: USDM }));
		});

		it('will not send a token when ADA cannot cover its min-UTxO', async () => {
			// 2.5 ADA - 2 ADA fee buffer = 0.5 ADA spendable: below the token
			// output's floor, so the USDM cannot ride out even though it is held.
			withBalance(2_500_000n, 500_000_000n);

			await processRequestsForFundWallet(fundWallet, [request('r1', 250_000_000n, USDM)]);

			expect(mockBuildAndSign).not.toHaveBeenCalled();
		});
	});

	it('sends nothing and raises no false alarm when the balance cannot be read', async () => {
		mockFetchAddressBalanceMap.mockRejectedValue(new Error('blockfrost unreachable'));

		await processRequestsForFundWallet(fundWallet, [request('r1', 20_000_000n)]);

		expect(mockBuildAndSign).not.toHaveBeenCalled();
		// "Could not read the balance" is not "the balance is zero". Continuing
		// with 0n would fire the underfunded alert at an operator whose treasury is
		// fine, and page them for an indexer outage.
		expect(mockTriggerLowBalance).not.toHaveBeenCalled();
	});

	it('does nothing when given no requests', async () => {
		await processRequestsForFundWallet(fundWallet, []);

		expect(mockFetchAddressBalanceMap).not.toHaveBeenCalled();
		expect(mockBuildAndSign).not.toHaveBeenCalled();
	});
});
