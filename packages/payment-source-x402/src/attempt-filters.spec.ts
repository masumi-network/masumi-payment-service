import { X402PaymentDirection, X402PaymentStatus } from '@masumi/payment-core/db';
import { buildX402AttemptWhere } from './attempt-filters';

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

	it('selects Verified attempts with a recorded error when the manual-action filter is on', () => {
		expect(buildX402AttemptWhere({ filterNeedsManualAction: true })).toEqual({
			direction: undefined,
			status: X402PaymentStatus.Verified,
			errorReason: { not: null },
		});
	});

	it('overrides an explicit status filter when the manual-action filter is on', () => {
		expect(
			buildX402AttemptWhere({
				status: X402PaymentStatus.Settled,
				filterNeedsManualAction: true,
			}),
		).toEqual(expect.objectContaining({ status: X402PaymentStatus.Verified, errorReason: { not: null } }));
	});
});
