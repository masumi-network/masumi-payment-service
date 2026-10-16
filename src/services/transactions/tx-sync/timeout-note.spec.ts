import { describe, expect, it } from '@jest/globals';
import { buildPurchaseTimeoutNote } from './timeout-note';

describe('buildPurchaseTimeoutNote', () => {
	it('keeps the plain note when nothing else is known', () => {
		expect(
			buildPurchaseTimeoutNote({
				payByTime: 5n,
				graceSeconds: 300,
				previousErrorNote: null,
				heldPurchasingWallets: [],
			}),
		).toBe(
			'Purchase request payByTime (5) passed without on-chain lock; no FundsLocked tx observed within 300s grace.',
		);
	});

	it('names a held purchasing wallet and keeps the earlier error', () => {
		const note = buildPurchaseTimeoutNote({
			payByTime: 5n,
			graceSeconds: 300,
			previousErrorNote: 'Not enough funds in wallets',
			heldPurchasingWallets: [
				{ id: 'wallet-1', lockedAt: new Date('2026-09-30T06:05:41.395Z'), pendingTransactionId: 'tx-1' },
			],
		});
		expect(note).toContain('wallet-1 (pending tx tx-1 since 2026-09-30T06:05:41.395Z)');
		expect(note).toContain('Previous error: Not enough funds in wallets');
	});
});
