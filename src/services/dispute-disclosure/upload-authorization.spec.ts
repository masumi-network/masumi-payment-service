import { describe, expect, it } from '@jest/globals';
import createHttpError from 'http-errors';
import { assertCanUploadDisclosureInput, assertCanUploadDisclosureResult } from './upload-authorization';
import type { DisputedRequestRow } from './lookup';

const baseTarget: DisputedRequestRow = {
	kind: 'purchase',
	blockchainIdentifier: 'id',
	inputHash: 'abc',
	resultHash: 'def',
	smartContractWalletId: 'wallet-1',
	requestedById: 'buyer-key',
};

describe('upload-authorization', () => {
	it('allows purchase result upload for seller wallet scope', () => {
		expect(() =>
			assertCanUploadDisclosureResult(
				{
					id: 'seller-key',
					canAdmin: false,
					walletScopeIds: ['wallet-1'],
					networkLimit: [],
				} as never,
				baseTarget,
			),
		).not.toThrow();
	});

	it('blocks purchase result upload for buyer api key', () => {
		expect(() =>
			assertCanUploadDisclosureResult(
				{
					id: 'buyer-key',
					canAdmin: false,
					walletScopeIds: ['wallet-1'],
					networkLimit: [],
				} as never,
				baseTarget,
			),
		).toThrow(createHttpError(403, 'Buyer API key cannot upload result disclosure for this purchase'));
	});

	it('allows purchase input upload for buyer api key', () => {
		expect(() =>
			assertCanUploadDisclosureInput(
				{
					id: 'buyer-key',
					canAdmin: false,
					walletScopeIds: [],
					networkLimit: [],
				} as never,
				baseTarget,
			),
		).not.toThrow();
	});
});
