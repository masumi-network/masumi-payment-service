import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

type FundingSettings = { id: string; autoFund: boolean; automaticFundingLimitLovelace: bigint | null };
type SettingsInput = { id: string; autoFund?: boolean; automaticFundingLimitLovelace?: string | null };
type SettingsUpdate = {
	where: { id: string };
	data: { autoFund?: boolean; automaticFundingLimitLovelace?: bigint | null };
	select?: object;
};
const mockFindParticipant = jest.fn<(args: object) => Promise<FundingSettings | null>>();
const mockUpdate = jest.fn<(args: SettingsUpdate) => Promise<FundingSettings>>();
const transactionClient = { hydraLocalParticipant: { findUnique: mockFindParticipant, update: mockUpdate } };
const mockTransaction =
	jest.fn<(run: (tx: typeof transactionClient) => Promise<unknown>, options: object) => Promise<unknown>>();
jest.unstable_mockModule('@masumi/payment-core/auth', () => ({
	adminAuthenticatedEndpointFactory: { build: (definition: unknown) => definition },
}));
jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: { ...transactionClient, $transaction: mockTransaction },
}));
jest.unstable_mockModule('@masumi/payment-core/serializable-semaphore', () => ({
	withSerializableSlotRetry: async (operation: () => Promise<unknown>) => await operation(),
}));
jest.unstable_mockModule('@/services/hydra-node-funding/service', () => ({
	fundHydraNodeNow: jest.fn(),
	readNodeFundingPolicy: async () => ({
		autoFund: true,
		automaticFundingLimitLovelace: null,
		fundedLovelace: '0',
		remainingFundingLovelace: null,
	}),
	readNodeFundingState: async () => ({
		address: 'addr_test1_node',
		balanceLovelace: 0n,
		isUnderfunded: true,
		shortfallLovelace: 30_000_000n,
		checked: true,
	}),
}));
jest.unstable_mockModule('@/services/hydra-node-funding/withdraw', () => ({ withdrawNodeFunds: jest.fn() }));
jest.unstable_mockModule('@/services/hydra-host/node-state', () => ({
	readParticipantNodeState: async () => ({ state: 'ready', isReady: true, reason: null }),
}));
let patch: { method: string; handler: (args: { input: SettingsInput }) => Promise<unknown> };
let get: { handler: (args: { input: { id: string } }) => Promise<unknown> };
let inputSchema: {
	parse: (input: unknown) => SettingsInput;
	safeParse: (input: unknown) => { success: boolean };
};
let stored: FundingSettings;
beforeAll(async () => {
	const endpoints = await import('./funding');
	patch = endpoints.participantFundingPatch as unknown as typeof patch;
	get = endpoints.participantFundingGet as unknown as typeof get;
	inputSchema = endpoints.participantFundingSettingsInput;
});
beforeEach(() => {
	jest.clearAllMocks();
	stored = { id: 'participant-1', autoFund: true, automaticFundingLimitLovelace: null };
	mockTransaction.mockImplementation(async (run) => await run(transactionClient));
	mockFindParticipant.mockImplementation(async () => stored);
	mockUpdate.mockImplementation(async ({ data }) => ({ ...stored, ...data }));
});

function call(input: SettingsInput) {
	return patch.handler({ input: inputSchema.parse(input) });
}

describe('per-node automatic funding settings', () => {
	it('reports the default unlimited setting when reading node funding', async () => {
		await expect(get.handler({ input: { id: 'participant-1' } })).resolves.toMatchObject({
			autoFund: true,
			automaticFundingLimitLovelace: null,
		});
	});

	it('clears an existing cap with an explicit null', async () => {
		stored.automaticFundingLimitLovelace = 30_000_000n;
		await expect(call({ id: stored.id, automaticFundingLimitLovelace: null })).resolves.toEqual({
			id: stored.id,
			autoFund: true,
			automaticFundingLimitLovelace: null,
		});
		expect(mockUpdate).toHaveBeenCalledWith(
			expect.objectContaining({ where: { id: stored.id }, data: { automaticFundingLimitLovelace: null } }),
		);
	});

	it.each(['0', '9223372036854775807'])('stores %s exactly as bigint and returns a decimal string', async (limit) => {
		await expect(call({ id: stored.id, automaticFundingLimitLovelace: limit })).resolves.toEqual({
			id: stored.id,
			autoFund: true,
			automaticFundingLimitLovelace: limit,
		});
		expect(mockUpdate).toHaveBeenCalledWith(
			expect.objectContaining({ data: { automaticFundingLimitLovelace: BigInt(limit) } }),
		);
	});

	it('preserves the existing cap when only automatic funding is changed', async () => {
		stored.automaticFundingLimitLovelace = 75_000_000n;
		await expect(call({ id: stored.id, autoFund: false })).resolves.toEqual({
			id: stored.id,
			autoFund: false,
			automaticFundingLimitLovelace: '75000000',
		});
		expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { autoFund: false } }));
	});

	it('updates both supplied settings in one serializable transaction', async () => {
		await call({ id: stored.id, autoFund: true, automaticFundingLimitLovelace: '60000000' });
		expect(patch.method).toBe('patch');
		expect(mockUpdate).toHaveBeenCalledTimes(1);
		expect(mockUpdate).toHaveBeenCalledWith(
			expect.objectContaining({ data: { autoFund: true, automaticFundingLimitLovelace: 60_000_000n } }),
		);
		expect(mockTransaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'Serializable' });
		expect(mockFindParticipant).toHaveBeenCalled();
	});

	it('returns HTTP 404 and writes nothing for a missing participant', async () => {
		mockFindParticipant.mockResolvedValue(null);
		await expect(call({ id: 'missing', automaticFundingLimitLovelace: null })).rejects.toMatchObject({ status: 404 });
		expect(mockUpdate).not.toHaveBeenCalled();
	});

	it.each(['', '-1', '1.5', '1e6', '01', '00', ' 1', '1 ', '+1', '9223372036854775808', '10000000000000000000'])(
		'rejects invalid limit %j before database access',
		(limit) => {
			expect(inputSchema.safeParse({ id: stored.id, automaticFundingLimitLovelace: limit }).success).toBe(false);
			expect(mockTransaction).not.toHaveBeenCalled();
			expect(mockUpdate).not.toHaveBeenCalled();
		},
	);

	it.each([
		{ id: 'participant-1' },
		{ id: '', autoFund: true },
		{ id: 'participant-1', automaticFundingLimitLovelace: 0 },
	])('rejects an empty update or invalid input %j', (input) => {
		expect(inputSchema.safeParse(input).success).toBe(false);
		expect(mockUpdate).not.toHaveBeenCalled();
	});
});
