import { describe, expect, it } from '@jest/globals';
import createHttpError from 'http-errors';
import { selectAuthorizedDisputedRow, type DisputedRequestRow } from './lookup';

const paymentRow: DisputedRequestRow = {
	kind: 'payment',
	blockchainIdentifier: 'shared-id',
	inputHash: 'in',
	resultHash: 'out',
	smartContractWalletId: 'seller-wallet',
	requestedById: 'seller-api-key',
	sellerHotWalletId: 'seller-wallet',
};

const purchaseRow: DisputedRequestRow = {
	kind: 'purchase',
	blockchainIdentifier: 'shared-id',
	inputHash: 'in',
	resultHash: 'out',
	smartContractWalletId: 'buyer-wallet',
	requestedById: 'buyer-api-key',
	sellerHotWalletId: 'seller-hot',
};

describe('selectAuthorizedDisputedRow', () => {
	it('prefers payment row for seller input upload when both legs exist', () => {
		const selected = selectAuthorizedDisputedRow([purchaseRow, paymentRow], {
			id: 'seller-api-key',
			canAdmin: false,
			walletScopeIds: ['seller-wallet'],
			networkLimit: [],
		} as never, 'input');
		expect(selected.kind).toBe('payment');
	});

	it('prefers purchase row for buyer input upload when both legs exist', () => {
		const selected = selectAuthorizedDisputedRow([purchaseRow, paymentRow], {
			id: 'buyer-api-key',
			canAdmin: false,
			walletScopeIds: null,
			networkLimit: [],
		} as never, 'input');
		expect(selected.kind).toBe('purchase');
	});

	it('throws 403 when caller cannot upload to either leg', () => {
		expect(() =>
			selectAuthorizedDisputedRow([purchaseRow, paymentRow], {
				id: 'other-key',
				canAdmin: false,
				walletScopeIds: ['unrelated'],
				networkLimit: [],
			} as never, 'input'),
		).toThrow(createHttpError(403, 'Not authorized to upload input disclosure for this request'));
	});
});
