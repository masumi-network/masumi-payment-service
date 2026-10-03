import { describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const { canReleaseTopupWallet, isOwnTopupOutstanding, outstandingOwnTopupWhere } = await import('./wallet-release');

describe('outstandingOwnTopupWhere', () => {
	// The scope IS the fix. Asked participant-wide, a call refused because an
	// earlier top-up is still Pending keeps the lock it just took even though it
	// put nothing on chain — and with an earlier row that can never resolve, the
	// thirty-second auto-top-up cycle renews that lock forever.
	it('names this operation own row and nothing about the participant', () => {
		const where = outstandingOwnTopupWhere('topup-1');

		expect(where.id).toBe('topup-1');
		expect(where.hydraLocalParticipantId).toBeUndefined();
	});

	it('asks only about the states that can still put a deposit on chain', () => {
		expect(outstandingOwnTopupWhere('topup-1').status).toEqual({ in: ['Pending', 'Preparing'] });
	});
});

describe('canReleaseTopupWallet', () => {
	// The 409 path: this call claimed the wallet, was refused before creating a
	// row, and owns no transaction. Holding on costs the whole stale-lock window.
	it('releases when this operation never created a row', () => {
		expect(canReleaseTopupWallet({ outstandingOwnTopup: false, carveTxHash: null, depositConfirmed: false })).toBe(
			true,
		);
	});

	it('holds while this operation own deposit could still land', () => {
		expect(canReleaseTopupWallet({ outstandingOwnTopup: true, carveTxHash: null, depositConfirmed: false })).toBe(
			false,
		);
	});

	// A signed carve may be in the mempool whatever happened afterwards: its
	// inputs still read as unspent, so a batcher handed the wallet here builds
	// over them and one of the two dies as BadInputsUTxO.
	it('holds after a signed carve until the deposit that spends it confirms', () => {
		expect(
			canReleaseTopupWallet({ outstandingOwnTopup: false, carveTxHash: 'ab'.repeat(32), depositConfirmed: false }),
		).toBe(false);
		expect(
			canReleaseTopupWallet({ outstandingOwnTopup: false, carveTxHash: 'ab'.repeat(32), depositConfirmed: true }),
		).toBe(true);
	});
});

describe('isOwnTopupOutstanding', () => {
	it('answers from the probe', async () => {
		await expect(isOwnTopupOutstanding('topup-1', async () => true)).resolves.toBe(true);
		await expect(isOwnTopupOutstanding('topup-1', async () => false)).resolves.toBe(false);
	});

	it('has nothing to ask about when no row was created', async () => {
		const probe = jest.fn(async () => true);

		await expect(isOwnTopupOutstanding(null, probe)).resolves.toBe(false);
		expect(probe).not.toHaveBeenCalled();
	});

	// The caller asks from a `finally`. A throw there replaces the outcome the
	// operation actually had — a submitted deposit reported as a failure — and
	// skips the release with it.
	it('keeps the lock rather than throwing when the probe cannot answer', async () => {
		await expect(
			isOwnTopupOutstanding('topup-1', () => Promise.reject(new Error('connection terminated'))),
		).resolves.toBe(true);
	});
});
