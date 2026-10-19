import { describe, expect, it } from '@jest/globals';
import createHttpError from 'http-errors';
import { assertDisclosureReadWalletInScope } from './disclosure-read-wallet-scope';

describe('disclosure-read-wallet-scope', () => {
	it('allows unrestricted read keys', () => {
		expect(() =>
			assertDisclosureReadWalletInScope(null, {
				kind: 'payment',
				smartContractWalletId: 'seller-wallet',
				sellerHotWalletId: null,
			}),
		).not.toThrow();
	});

	it('requires seller wallet scope for payment disputes', () => {
		expect(() =>
			assertDisclosureReadWalletInScope(['seller-wallet'], {
				kind: 'payment',
				smartContractWalletId: 'seller-wallet',
				sellerHotWalletId: null,
			}),
		).not.toThrow();
		expect(() =>
			assertDisclosureReadWalletInScope(['buyer-wallet'], {
				kind: 'payment',
				smartContractWalletId: 'seller-wallet',
				sellerHotWalletId: null,
			}),
		).toThrow(createHttpError(404, 'Not found'));
	});
});
