import { X402PaymentDirection, X402PaymentStatus } from '@masumi/payment-core/db';
import { buildX402AttemptWhere } from './attempt-filters';
import { SETTLE_STALE_MS } from './settle-lock';

describe('buildX402AttemptWhere', () => {
	const databaseNow = new Date('2026-07-16T12:00:00.000Z');

	it('passes plain filters through when the manual-action filter is off', () => {
		expect(
			buildX402AttemptWhere({
				status: X402PaymentStatus.Settled,
				direction: X402PaymentDirection.InboundSettle,
				caip2Network: 'eip155:8453',
			}),
		).toEqual({
			status: X402PaymentStatus.Settled,
			direction: X402PaymentDirection.InboundSettle,
			// Network is filtered through the rail relation now that the attempt has no caip2Network column.
			Network: { caip2Id: 'eip155:8453' },
		});
	});

	it('selects the full reconciliation backlog when the manual-action filter is on', () => {
		const where = buildX402AttemptWhere({ filterNeedsManualAction: true }, databaseNow);

		expect(where).toEqual({
			direction: undefined,
			OR: [
				// A stale pre-settle marker, with or without an explicit error trace.
				{
					direction: X402PaymentDirection.InboundSettle,
					status: X402PaymentStatus.Verified,
					updatedAt: { lt: expect.any(Date) },
					NOT: { EvmWallet: { is: { lockedAt: { gte: expect.any(Date) } } } },
				},
				// Settle succeeded but the settlement row was never persisted.
				{
					direction: X402PaymentDirection.InboundSettle,
					status: X402PaymentStatus.Settled,
					Settlement: { is: null },
					updatedAt: { lt: expect.any(Date) },
					NOT: { EvmWallet: { is: { lockedAt: { gte: expect.any(Date) } } } },
				},
			],
		});

		// The stuck bound comes from the shared database clock, so a host clock jump cannot
		// surface another instance's active settle in the backlog.
		const or = (
			where as {
				OR: Array<{
					updatedAt?: { lt: Date };
					NOT?: { EvmWallet?: { is?: { lockedAt?: { gte: Date } } } };
				}>;
			}
		).OR;
		for (const branch of or) {
			const stuckBefore = branch.updatedAt!.lt.getTime();
			expect(stuckBefore).toBe(databaseNow.getTime() - SETTLE_STALE_MS);
			// Listing and reconciliation share one lease boundary: a wallet renewed at or after
			// the cutoff keeps the attempt out of the operator backlog.
			expect(branch.NOT!.EvmWallet!.is!.lockedAt!.gte).toBe(branch.updatedAt!.lt);
		}
	});

	it('overrides an explicit status filter when the manual-action filter is on', () => {
		const where = buildX402AttemptWhere(
			{
				status: X402PaymentStatus.Settled,
				filterNeedsManualAction: true,
			},
			databaseNow,
		);
		// No top-level status: the backlog branches carry their own, so the explicit filter is ignored.
		expect(where).not.toHaveProperty('status');
		expect(where.OR?.[0]).toEqual({
			direction: X402PaymentDirection.InboundSettle,
			status: X402PaymentStatus.Verified,
			updatedAt: { lt: expect.any(Date) },
			NOT: { EvmWallet: { is: { lockedAt: { gte: expect.any(Date) } } } },
		});
	});

	it('maps side=buy to the outbound direction', () => {
		expect(buildX402AttemptWhere({ side: 'buy' })).toMatchObject({
			direction: X402PaymentDirection.OutboundPayment,
		});
	});

	it('maps side=sell to both inbound directions', () => {
		expect(buildX402AttemptWhere({ side: 'sell' })).toMatchObject({
			direction: { in: [X402PaymentDirection.InboundVerify, X402PaymentDirection.InboundSettle] },
		});
	});

	it('lets an explicit direction win over side', () => {
		expect(buildX402AttemptWhere({ side: 'sell', direction: X402PaymentDirection.InboundSettle })).toMatchObject({
			direction: X402PaymentDirection.InboundSettle,
		});
	});

	it('scopes to the initiating apiKeyId when provided (tenant isolation)', () => {
		expect(buildX402AttemptWhere({ apiKeyId: 'api-key-1' })).toMatchObject({ apiKeyId: 'api-key-1' });
	});

	it('applies the apiKeyId scope to the manual-action backlog too', () => {
		expect(buildX402AttemptWhere({ apiKeyId: 'api-key-1', filterNeedsManualAction: true }, databaseNow)).toMatchObject({
			apiKeyId: 'api-key-1',
		});
	});

	it('requires a database-clock snapshot for manual-action staleness', () => {
		expect(() => buildX402AttemptWhere({ filterNeedsManualAction: true })).toThrow(
			'databaseNow is required for the x402 manual-action filter',
		);
	});
});
