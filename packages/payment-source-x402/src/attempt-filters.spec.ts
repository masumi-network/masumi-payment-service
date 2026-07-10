import { X402PaymentDirection, X402PaymentStatus } from '@masumi/payment-core/db';
import { buildX402AttemptWhere } from './attempt-filters';
import { SETTLE_STALE_MS } from './settle-lock';

describe('buildX402AttemptWhere', () => {
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
		const before = Date.now();
		const where = buildX402AttemptWhere({ filterNeedsManualAction: true });
		const after = Date.now();

		expect(where).toEqual({
			direction: undefined,
			OR: [
				// Settle left an explicit error trace (threw / facilitator failure). Pinned to
				// InboundSettle: reconcile refuses verifies, so an errored verify row must not
				// surface as an unclearable backlog entry.
				{
					direction: X402PaymentDirection.InboundSettle,
					status: X402PaymentStatus.Verified,
					errorReason: { not: null },
				},
				// Interrupted mid-settle: a stale trace-less pre-settle marker.
				{
					direction: X402PaymentDirection.InboundSettle,
					status: X402PaymentStatus.Verified,
					updatedAt: { lt: expect.any(Date) },
				},
				// Settle succeeded but the settlement row was never persisted.
				{
					direction: X402PaymentDirection.InboundSettle,
					status: X402PaymentStatus.Settled,
					Settlement: { is: null },
					updatedAt: { lt: expect.any(Date) },
				},
			],
		});

		// The stuck bound is "now minus the settle stale window", so live in-flight settles
		// (which are always younger than SETTLE_STALE_MS) never appear in the backlog.
		const or = (where as { OR: Array<{ updatedAt?: { lt: Date } }> }).OR;
		for (const branch of [or[1], or[2]]) {
			const stuckBefore = branch.updatedAt!.lt.getTime();
			expect(stuckBefore).toBeGreaterThanOrEqual(before - SETTLE_STALE_MS);
			expect(stuckBefore).toBeLessThanOrEqual(after - SETTLE_STALE_MS);
		}
	});

	it('overrides an explicit status filter when the manual-action filter is on', () => {
		const where = buildX402AttemptWhere({
			status: X402PaymentStatus.Settled,
			filterNeedsManualAction: true,
		});
		// No top-level status: the backlog branches carry their own, so the explicit filter is ignored.
		expect(where).not.toHaveProperty('status');
		expect(where.OR?.[0]).toEqual({
			direction: X402PaymentDirection.InboundSettle,
			status: X402PaymentStatus.Verified,
			errorReason: { not: null },
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
		expect(buildX402AttemptWhere({ apiKeyId: 'api-key-1', filterNeedsManualAction: true })).toMatchObject({
			apiKeyId: 'api-key-1',
		});
	});
});
