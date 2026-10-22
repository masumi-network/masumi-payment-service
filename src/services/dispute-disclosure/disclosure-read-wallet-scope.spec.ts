import { describe, expect, it } from '@jest/globals';
import createHttpError from 'http-errors';
import { assertDisclosureReadWalletInScope, isDisclosureReadWalletInScope } from './disclosure-read-wallet-scope';

describe('disclosure-read-wallet-scope', () => {
	it('allows purchase buyer smart contract wallet for read', () => {
		expect(
			isDisclosureReadWalletInScope(['buyer-hot'], {
				kind: 'purchase',
				smartContractWalletId: 'buyer-hot',
				sellerHotWalletId: 'seller-hot',
			}),
		).toBe(true);
	});

	it('allows purchase seller hot wallet for read', () => {
		expect(
			isDisclosureReadWalletInScope(['seller-hot'], {
				kind: 'purchase',
				smartContractWalletId: 'buyer-hot',
				sellerHotWalletId: 'seller-hot',
			}),
		).toBe(true);
	});

	it('rejects unrelated wallets on purchase leg', () => {
		expect(() =>
			assertDisclosureReadWalletInScope(['other'], {
				kind: 'purchase',
				smartContractWalletId: 'buyer-hot',
				sellerHotWalletId: 'seller-hot',
			}),
		).toThrow(createHttpError(404, 'Not found'));
	});

	it('skips scope checks for admin keys', () => {
		expect(() =>
			assertDisclosureReadWalletInScope(['other'], {
				kind: 'payment',
				smartContractWalletId: 'seller-only',
				sellerHotWalletId: null,
				canAdmin: true,
			}),
		).not.toThrow();
	});
});
