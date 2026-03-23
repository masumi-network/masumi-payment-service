import { getBillableFunds, isPaymentBillable } from './billing';

describe('monthly invoice billing helpers', () => {
	it('treats confirmed withdrawn payments as billable', () => {
		expect(
			isPaymentBillable({
				onChainState: 'Withdrawn',
				unlockTime: BigInt(Date.now() + 10_000),
				WithdrawnForSeller: [],
				TransactionHistory: [{ txHash: 'tx-1' }],
			}),
		).toBe(true);
	});

	it('rejects payments without confirmed on-chain history', () => {
		expect(
			isPaymentBillable({
				onChainState: 'Withdrawn',
				unlockTime: BigInt(Date.now() + 10_000),
				WithdrawnForSeller: [],
				TransactionHistory: [{ txHash: null }],
			}),
		).toBe(false);
	});

	it('uses withdrawn seller funds for disputed withdrawals', () => {
		expect(
			getBillableFunds({
				onChainState: 'DisputedWithdrawn',
				RequestedFunds: [{ unit: 'lovelace', amount: BigInt(100) }],
				WithdrawnForSeller: [{ unit: 'lovelace', amount: BigInt(50) }],
			}),
		).toEqual([{ unit: '', amount: BigInt(50) }]);
	});
});
