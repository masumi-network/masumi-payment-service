import { describe, expect, it } from '@jest/globals';
import { buildFundsFitMissNote, buildPurchaseTimeoutNote, isFundsFitMissNote } from './timeout-note';

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

describe('funds fit-miss note', () => {
	const note = buildFundsFitMissNote({
		unit: 'c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad0014df105553444d',
		requiredAmount: '900000',
		availableAmount: '400000',
		freeWalletCount: 1,
		eligibleWalletCount: 1,
	});

	it('is recognised as a funds shortage, a plain timeout note is not', () => {
		expect(note).toBe(
			'Not enough funds in the free purchasing wallets: c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad0014df105553444d needs 900000, the best free wallet has 400000 (1 of 1 eligible wallets free).',
		);
		expect(isFundsFitMissNote(note)).toBe(true);
		expect(isFundsFitMissNote(null)).toBe(false);
		expect(
			isFundsFitMissNote(
				buildPurchaseTimeoutNote({
					payByTime: 5n,
					graceSeconds: 300,
					previousErrorNote: null,
					heldPurchasingWallets: [],
				}),
			),
		).toBe(false);
	});

	it('names lovelace for the ADA unit and survives into the timeout note', () => {
		const ada = buildFundsFitMissNote({
			unit: '',
			requiredAmount: '3000000',
			availableAmount: '1000000',
			freeWalletCount: 2,
			eligibleWalletCount: 2,
		});
		expect(ada).toContain('lovelace needs 3000000');
		const timeout = buildPurchaseTimeoutNote({
			payByTime: 5n,
			graceSeconds: 300,
			previousErrorNote: note,
			heldPurchasingWallets: [],
		});
		expect(timeout).toContain(`Previous error: ${note}`);
	});
});
