import { describe, expect, it } from '@jest/globals';
import { Network } from '@/generated/prisma/client';
import { pickReadRevealContext, type RevealDataPaymentContext } from './reveal-data-signature';

const paymentContext: RevealDataPaymentContext = {
	requestKind: 'payment',
	blockchainIdentifier: 'chain-1',
	inputHash: 'in',
	resultHash: 'out',
	smartContractWalletId: 'seller-smart',
	sellerHotWalletId: 'seller-smart',
	network: Network.Preprod,
	adminWalletAddresses: [],
};

const purchaseContext: RevealDataPaymentContext = {
	requestKind: 'purchase',
	blockchainIdentifier: 'chain-1',
	inputHash: 'in',
	resultHash: 'out',
	smartContractWalletId: 'buyer-hot',
	sellerHotWalletId: 'seller-hot',
	network: Network.Preprod,
	adminWalletAddresses: [],
};

describe('pickReadRevealContext', () => {
	it('prefers purchase leg for scoped buyer read keys when both legs exist', () => {
		const picked = pickReadRevealContext([paymentContext, purchaseContext], {
			walletScopeIds: ['buyer-hot'],
		});
		expect(picked?.requestKind).toBe('purchase');
	});

	it('falls back to payment leg for seller-scoped keys', () => {
		const picked = pickReadRevealContext([paymentContext, purchaseContext], {
			walletScopeIds: ['seller-smart'],
		});
		expect(picked?.requestKind).toBe('payment');
	});
});
