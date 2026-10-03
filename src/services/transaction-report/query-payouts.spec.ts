import { jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import { OnChainState, PaymentSourceType } from '@/generated/prisma/client';

const mockResolvePaymentKeyHash = jest.fn() as Mock<(address: string) => string>;

jest.unstable_mockModule('@meshsdk/core-cst', () => ({
	resolvePaymentKeyHash: mockResolvePaymentKeyHash,
}));

const { getReportPayoutCompleteness } = await import('./query-payouts');

describe('getReportPayoutCompleteness', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockResolvePaymentKeyHash.mockReturnValue('wallet-vkey');
	});

	it.each([PaymentSourceType.Web3CardanoV1, PaymentSourceType.Web3CardanoV2])(
		'marks disputed %s buyer collateral as partial',
		(paymentSourceType) => {
			expect(
				getReportPayoutCompleteness({
					paymentSourceType,
					onChainState: OnChainState.DisputedWithdrawn,
					returnAddress: 'addr-return',
					expectedWalletVkey: 'wallet-vkey',
					buyerCollateralReturnLovelace: 2_000_000n,
				}),
			).toBe('partial');
		},
	);

	it('marks an unknown disputed buyer collateral value as partial', () => {
		expect(
			getReportPayoutCompleteness({
				paymentSourceType: PaymentSourceType.Web3CardanoV1,
				onChainState: OnChainState.DisputedWithdrawn,
				returnAddress: null,
				expectedWalletVkey: null,
				buyerCollateralReturnLovelace: null,
			}),
		).toBe('partial');
	});

	it('marks an empty V1 disputed payout partial because legacy rows have no payout provenance', () => {
		expect(
			getReportPayoutCompleteness({
				paymentSourceType: PaymentSourceType.Web3CardanoV1,
				onChainState: OnChainState.DisputedWithdrawn,
				returnAddress: null,
				expectedWalletVkey: null,
				buyerCollateralReturnLovelace: 0n,
				hasStoredPayoutEvidence: false,
			}),
		).toBe('partial');
	});

	it('keeps a nonempty V1 disputed payout complete', () => {
		expect(
			getReportPayoutCompleteness({
				paymentSourceType: PaymentSourceType.Web3CardanoV1,
				onChainState: OnChainState.DisputedWithdrawn,
				returnAddress: null,
				expectedWalletVkey: null,
				buyerCollateralReturnLovelace: 0n,
				hasStoredPayoutEvidence: true,
			}),
		).toBe('complete');
	});

	it('requires the V2 return address to match the expected wallet key', () => {
		const input = {
			paymentSourceType: PaymentSourceType.Web3CardanoV2,
			onChainState: OnChainState.DisputedWithdrawn,
			returnAddress: 'addr-return',
			expectedWalletVkey: 'wallet-vkey',
		};
		expect(getReportPayoutCompleteness(input)).toBe('complete');
		mockResolvePaymentKeyHash.mockReturnValue('different-vkey');
		expect(getReportPayoutCompleteness(input)).toBe('partial');
	});
});
