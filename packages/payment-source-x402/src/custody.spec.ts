import { describe, expect, it } from '@jest/globals';
import createHttpError from 'http-errors';

import { assertX402WalletCustody, buildX402WalletCustodyWhere } from './custody';

describe('x402 wallet custody', () => {
	it('buildX402WalletCustodyWhere returns empty for admin scope', () => {
		expect(buildX402WalletCustodyWhere(null)).toEqual({});
	});

	it('buildX402WalletCustodyWhere filters by createdById', () => {
		expect(buildX402WalletCustodyWhere('key-1')).toEqual({ createdById: 'key-1' });
	});

	it('assertX402WalletCustody allows admin scope', () => {
		expect(() => assertX402WalletCustody(null, { createdById: 'other' })).not.toThrow();
	});

	it('assertX402WalletCustody rejects foreign wallets', () => {
		expect(() => assertX402WalletCustody('key-1', { createdById: 'key-2' })).toThrow(
			createHttpError(404, 'Managed EVM wallet not found'),
		);
	});
});
