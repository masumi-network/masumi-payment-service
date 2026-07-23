import { describe, expect, it } from '@jest/globals';
import { TransactionLayer } from '@/generated/prisma/client';
import { transformPurchaseGetTimestamps } from './transformers';

describe('transformPurchaseGetTimestamps', () => {
	it('serializes buyer and seller-signed layer choices independently', () => {
		const result = transformPurchaseGetTimestamps({
			submitResultTime: 1n,
			payByTime: 2n,
			unlockTime: 3n,
			externalDisputeUnlockTime: 4n,
			buyerCoolDownTime: 5n,
			sellerCoolDownTime: 6n,
			forceLayer: TransactionLayer.L1,
			paymentForceLayer: TransactionLayer.L2,
		});

		expect(result.forceLayer).toBe('L1');
		expect(result.paymentForceLayer).toBe('Hydra');
	});
});
