import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';

type AnyMock = Mock<(...args: any[]) => any>;

const mockInviteFindMany = jest.fn() as AnyMock;
const mockHeadFindMany = jest.fn() as AnyMock;
const mockAdvanceRedemption = jest.fn() as AnyMock;

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		hydraHeadInvite: { findMany: mockInviteFindMany, updateMany: async () => ({ count: 1 }) },
		hydraHead: { findMany: mockHeadFindMany },
		paymentRequest: { count: async () => 0, findMany: async () => [] },
		purchaseRequest: { count: async () => 0, findMany: async () => [] },
	},
}));
jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('./orchestrator', () => ({ createHeadFromExchange: jest.fn() }));
jest.unstable_mockModule('./redemption', () => ({ advanceRedemption: mockAdvanceRedemption }));
jest.unstable_mockModule('./redemption-ports', () => ({
	buildRedemptionPorts: () => ({}),
	toRedemptionState: () => ({}),
	pairRelationWhere: () => ({}),
}));

let resumeHydraRedemptions: typeof import('./resume-redemptions').resumeHydraRedemptions;

beforeAll(async () => {
	({ resumeHydraRedemptions } = await import('./resume-redemptions'));
});

const acknowledged = {
	id: 'invite-1',
	nonce: 'nonce-1',
	role: 'Redeemer',
	status: 'Redeemed',
	redeemedAt: new Date(0),
	updatedAt: new Date(0),
	network: 'Preprod',
	localHotWalletId: 'wallet-1',
	issuerWalletAddress: 'addr_test1issuer',
	LocalHotWallet: { paymentSourceId: 'source-1' },
};

const settledFinalHead = {
	id: 'previous-head',
	status: 'Final',
	fanoutTxHash: 'f'.repeat(64),
	reconciliationCompletedAt: new Date(0),
	_count: { Transactions: 0 },
};

beforeEach(() => {
	jest.clearAllMocks();
	// The stale-unconfirmed sweep runs first and finds nothing; the pass finds the record.
	mockInviteFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([acknowledged]);
	mockAdvanceRedemption.mockResolvedValue({ hydraHeadId: 'head-2' });
});

describe('resuming an acknowledged redemption', () => {
	// Before, only a non-final head blocked the pass, so it started and funded the
	// node and then failed at head creation every minute until reconciliation.
	it('waits while the previous Final head has not handed off', async () => {
		mockHeadFindMany.mockResolvedValue([{ ...settledFinalHead, reconciliationCompletedAt: null }]);

		const outcome = await resumeHydraRedemptions();

		expect(outcome).toMatchObject({ blocked: 1, resumed: 0, failed: 0 });
		expect(mockAdvanceRedemption).not.toHaveBeenCalled();
	});

	it('carries on once the previous Final head has handed off', async () => {
		mockHeadFindMany.mockResolvedValue([settledFinalHead]);

		const outcome = await resumeHydraRedemptions();

		expect(outcome).toMatchObject({ blocked: 0, resumed: 1 });
		expect(mockAdvanceRedemption).toHaveBeenCalledTimes(1);
	});
});
