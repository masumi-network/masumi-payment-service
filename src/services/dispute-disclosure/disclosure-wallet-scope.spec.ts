import { describe, expect, it } from '@jest/globals';
import createHttpError from 'http-errors';
import {
	assertDisclosureInputWalletInScope,
	assertDisclosureResultWalletInScope,
} from './disclosure-wallet-scope';
import type { DisputedRequestRow } from './lookup';

const purchaseTarget: DisputedRequestRow = {
	kind: 'purchase',
	blockchainIdentifier: 'id',
	inputHash: 'a',
	resultHash: 'b',
	smartContractWalletId: null,
	requestedById: 'buyer-key-id',
	sellerHotWalletId: 'seller-hot',
};

describe('disclosure-wallet-scope', () => {
	it('skips purchase input wallet scope for the buyer requester', () => {
		expect(() =>
			assertDisclosureInputWalletInScope(['other-wallet'], purchaseTarget, 'buyer-key-id'),
		).not.toThrow();
	});

	it('requires seller wallet scope for purchase result upload', () => {
		expect(() => assertDisclosureResultWalletInScope(['seller-hot'], purchaseTarget)).not.toThrow();
		expect(() => assertDisclosureResultWalletInScope(['buyer-hot'], purchaseTarget)).toThrow(
			createHttpError(404, 'Not found'),
		);
	});
});
