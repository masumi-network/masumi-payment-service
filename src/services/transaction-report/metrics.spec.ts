import { describe, expect, it } from '@jest/globals';
import {
	calculateBuyerMetrics,
	calculateProtocolFee,
	calculateSellerMetrics,
	getSellerGrossRevenue,
	reconcileCardanoFees,
	type ReportMetricInput,
	type ReportOnChainState,
	type RevenueMode,
} from './metrics';

const requestedFunds = [
	{ unit: 'lovelace', amount: 100_000_000n },
	{ unit: 'policyasset', amount: 1_000n },
];
const sellerDisputedFunds = [{ unit: 'policyasset', amount: 400n }];

function metricInput(overrides: Partial<ReportMetricInput> = {}): ReportMetricInput {
	return {
		onChainState: 'Withdrawn',
		paymentSourceType: 'Web3CardanoV1',
		configuredFeeRatePermille: 50,
		unlockTime: 1_000n,
		asOfTime: 2_000n,
		hasConfirmedFundsLockedTransaction: true,
		hasConfirmedCurrentStateTransaction: true,
		requestedFunds,
		withdrawnForBuyer: [],
		withdrawnForSeller: sellerDisputedFunds,
		buyerPayoutCompleteness: 'complete',
		sellerPayoutCompleteness: 'complete',
		collateralReturnLovelace: 2_000_000n,
		buyerCardanoFees: 300_000n,
		sellerCardanoFees: 200_000n,
		...overrides,
	};
}

describe('getSellerGrossRevenue', () => {
	const zeroStates: Array<ReportOnChainState | null> = [
		null,
		'FundsLocked',
		'FundsOrDatumInvalid',
		'RefundRequested',
		'Disputed',
		'WithdrawAuthorized',
		'RefundAuthorized',
		'RefundWithdrawn',
	];

	it.each(zeroStates)('returns zero billable and cash revenue for %s', (onChainState) => {
		const input = metricInput({ onChainState });
		expect(getSellerGrossRevenue(input, 'Billable')).toEqual([]);
		expect(getSellerGrossRevenue(input, 'CashReceived')).toEqual([]);
	});

	it.each<RevenueMode>(['Billable', 'CashReceived', 'RequestedGross'])(
		'uses requested funds for Withdrawn in %s mode',
		(mode) => {
			expect(getSellerGrossRevenue(metricInput(), mode)).toEqual(requestedFunds);
		},
	);

	it('uses requested funds for unlocked ResultSubmitted billable revenue', () => {
		expect(getSellerGrossRevenue(metricInput({ onChainState: 'ResultSubmitted' }), 'Billable')).toEqual(requestedFunds);
	});

	it('does not recognize locked ResultSubmitted revenue', () => {
		expect(
			getSellerGrossRevenue(metricInput({ onChainState: 'ResultSubmitted', unlockTime: 2_001n }), 'Billable'),
		).toEqual([]);
	});

	it('uses only the seller disputed payout for billable and cash revenue', () => {
		const input = metricInput({ onChainState: 'DisputedWithdrawn' });
		expect(getSellerGrossRevenue(input, 'Billable')).toEqual(sellerDisputedFunds);
		expect(getSellerGrossRevenue(input, 'CashReceived')).toEqual(sellerDisputedFunds);
		expect(getSellerGrossRevenue(input, 'RequestedGross')).toEqual(requestedFunds);
	});

	it('returns null for an incomplete disputed seller payout', () => {
		expect(
			getSellerGrossRevenue(
				metricInput({ onChainState: 'DisputedWithdrawn', sellerPayoutCompleteness: 'partial' }),
				'Billable',
			),
		).toBeNull();
	});

	it.each(zeroStates)('uses requested funds for %s in RequestedGross mode', (onChainState) => {
		expect(getSellerGrossRevenue(metricInput({ onChainState }), 'RequestedGross')).toEqual(requestedFunds);
	});

	it('keeps RequestedGross exact without confirmed chain evidence', () => {
		expect(
			getSellerGrossRevenue(
				metricInput({
					onChainState: null,
					hasConfirmedFundsLockedTransaction: false,
					hasConfirmedCurrentStateTransaction: false,
				}),
				'RequestedGross',
			),
		).toEqual(requestedFunds);
	});

	it('returns partial revenue when the current state lacks exact confirmed evidence', () => {
		expect(getSellerGrossRevenue(metricInput({ hasConfirmedCurrentStateTransaction: false }), 'Billable')).toBeNull();
	});
});

describe('calculateProtocolFee', () => {
	it('uses reconstructed locked ADA and applies the V1 minimum fee', () => {
		expect(calculateProtocolFee(metricInput(), 'Billable')).toEqual({
			configuredRatePermille: 50,
			appliedRatePermille: 50,
			amounts: [
				{ unit: 'lovelace', amount: 5_100_000n },
				{ unit: 'policyasset', amount: 50n },
			],
			provenance: 'calculated',
			basis: 'stored_requested_plus_collateral',
			completeness: 'reconstructed',
		});
	});

	it('applies the ADA floor to token-only payments', () => {
		const input = metricInput({
			requestedFunds: [{ unit: 'policyasset', amount: 1_000n }],
			collateralReturnLovelace: 2_000_000n,
		});
		expect(calculateProtocolFee(input, 'Billable').amounts).toEqual([
			{ unit: 'lovelace', amount: 1_435_230n },
			{ unit: 'policyasset', amount: 50n },
		]);
	});

	it('uses integer floor division for native assets', () => {
		const input = metricInput({
			requestedFunds: [
				{ unit: 'lovelace', amount: 2_000_000n },
				{ unit: 'policyasset', amount: 21n },
			],
			collateralReturnLovelace: 0n,
		});
		expect(calculateProtocolFee(input, 'Billable').amounts).toEqual([
			{ unit: 'lovelace', amount: 1_435_230n },
			{ unit: 'policyasset', amount: 1n },
		]);
	});

	it('marks an unlocked ResultSubmitted V1 fee as projected', () => {
		expect(calculateProtocolFee(metricInput({ onChainState: 'ResultSubmitted' }), 'Billable').provenance).toBe(
			'projected',
		);
	});

	it.each([
		['Withdrawn', 'Billable', 'calculated'],
		['Withdrawn', 'CashReceived', 'calculated'],
		['Withdrawn', 'RequestedGross', 'calculated'],
		['ResultSubmitted', 'Billable', 'projected'],
		['ResultSubmitted', 'CashReceived', 'not_applicable'],
		['ResultSubmitted', 'RequestedGross', 'not_applicable'],
	] as const)('uses %s protocol-fee applicability in %s mode', (onChainState, revenueMode, provenance) => {
		expect(calculateProtocolFee(metricInput({ onChainState }), revenueMode).provenance).toBe(provenance);
	});

	it('returns insufficient protocol fee data without exact current-state evidence', () => {
		expect(calculateProtocolFee(metricInput({ hasConfirmedCurrentStateTransaction: false }), 'Billable')).toMatchObject(
			{
				appliedRatePermille: null,
				amounts: null,
				provenance: 'insufficient_data',
				completeness: 'insufficient_data',
			},
		);
	});

	it('returns an exact zero for applicable V2 rows', () => {
		expect(calculateProtocolFee(metricInput({ paymentSourceType: 'Web3CardanoV2' }), 'Billable')).toEqual({
			configuredRatePermille: 50,
			appliedRatePermille: 0,
			amounts: [],
			provenance: 'exact_zero',
			basis: 'contract_version',
			completeness: 'exact',
		});
	});

	it('keeps V2 non-revenue states not applicable', () => {
		expect(
			calculateProtocolFee(
				metricInput({ paymentSourceType: 'Web3CardanoV2', onChainState: 'FundsLocked' }),
				'Billable',
			),
		).toEqual({
			configuredRatePermille: 50,
			appliedRatePermille: null,
			amounts: null,
			provenance: 'not_applicable',
			basis: null,
			completeness: 'not_applicable',
		});
	});

	it('returns not applicable for a non-revenue state', () => {
		expect(calculateProtocolFee(metricInput({ onChainState: 'FundsLocked' }), 'Billable')).toEqual({
			configuredRatePermille: 50,
			appliedRatePermille: null,
			amounts: null,
			provenance: 'not_applicable',
			basis: null,
			completeness: 'not_applicable',
		});
	});

	it('returns insufficient data when collateral is unknown', () => {
		expect(calculateProtocolFee(metricInput({ collateralReturnLovelace: null }), 'Billable')).toEqual({
			configuredRatePermille: 50,
			appliedRatePermille: 50,
			amounts: null,
			provenance: 'insufficient_data',
			basis: null,
			completeness: 'insufficient_data',
		});
	});

	it('returns insufficient data when reconstructed token-only ADA is absent', () => {
		expect(
			calculateProtocolFee(
				metricInput({
					requestedFunds: [{ unit: 'policyasset', amount: 1_000n }],
					collateralReturnLovelace: 0n,
				}),
				'Billable',
			),
		).toMatchObject({
			amounts: null,
			provenance: 'insufficient_data',
			completeness: 'insufficient_data',
		});
	});

	it('rejects a negative requested entry before duplicate normalization', () => {
		expect(() =>
			calculateProtocolFee(
				metricInput({
					requestedFunds: [
						{ unit: 'lovelace', amount: -1n },
						{ unit: '', amount: 100_000_001n },
					],
				}),
				'Billable',
			),
		).toThrow('requested funds must not be negative');
	});

	it.each([-1, 1001, 1.5])('rejects invalid fee rate %s', (configuredFeeRatePermille) => {
		expect(() => calculateProtocolFee(metricInput({ configuredFeeRatePermille }), 'Billable')).toThrow(
			'configuredFeeRatePermille must be an integer from 0 through 1000',
		);
	});
});

describe('calculateSellerMetrics', () => {
	it('subtracts protocol and seller Cardano fees from their own asset units', () => {
		expect(calculateSellerMetrics(metricInput(), 'Billable')).toEqual({
			grossRevenue: requestedFunds,
			protocolFee: calculateProtocolFee(metricInput(), 'Billable'),
			cardanoFees: [{ unit: 'lovelace', amount: 200_000n }],
			netRevenue: [
				{ unit: 'lovelace', amount: 94_700_000n },
				{ unit: 'policyasset', amount: 950n },
			],
		});
	});

	it('returns null net revenue when protocol fee data is incomplete', () => {
		expect(calculateSellerMetrics(metricInput({ collateralReturnLovelace: null }), 'Billable').netRevenue).toBeNull();
	});
});

describe('calculateBuyerMetrics', () => {
	it('marks confirmed invalid on-chain funds as unknown spend', () => {
		expect(calculateBuyerMetrics(metricInput({ onChainState: 'FundsOrDatumInvalid' })).grossSpend).toBeNull();
	});

	it('keeps an invalid request unknown when chain evidence is missing', () => {
		expect(
			calculateBuyerMetrics(
				metricInput({
					onChainState: 'FundsOrDatumInvalid',
					hasConfirmedCurrentStateTransaction: false,
				}),
			).grossSpend,
		).toBeNull();
	});
	it('shows locked gross spend before settlement', () => {
		expect(calculateBuyerMetrics(metricInput({ onChainState: 'FundsLocked' }))).toEqual({
			grossSpend: requestedFunds,
			returnedFunds: [],
			cardanoFees: [{ unit: 'lovelace', amount: 300_000n }],
			netSpend: [
				{ unit: 'lovelace', amount: 100_300_000n },
				{ unit: 'policyasset', amount: 1_000n },
			],
		});
	});

	it.each<ReportOnChainState>([
		'FundsLocked',
		'ResultSubmitted',
		'RefundRequested',
		'Disputed',
		'WithdrawAuthorized',
		'RefundAuthorized',
		'Withdrawn',
		'RefundWithdrawn',
		'DisputedWithdrawn',
	])('returns partial gross spend for %s without confirmed FundsLocked evidence', (onChainState) => {
		expect(
			calculateBuyerMetrics(metricInput({ onChainState, hasConfirmedFundsLockedTransaction: false })).grossSpend,
		).toBeNull();
	});

	it('returns known zero gross spend for a pending request without FundsLocked evidence', () => {
		expect(
			calculateBuyerMetrics(metricInput({ onChainState: null, hasConfirmedFundsLockedTransaction: false })).grossSpend,
		).toEqual([]);
	});

	it('uses requested funds as a settled full refund', () => {
		const result = calculateBuyerMetrics(metricInput({ onChainState: 'RefundWithdrawn' }));
		expect(result.returnedFunds).toEqual(requestedFunds);
		expect(result.netSpend).toEqual([{ unit: 'lovelace', amount: 300_000n }]);
	});

	it('uses the actual disputed buyer payout', () => {
		const result = calculateBuyerMetrics(
			metricInput({
				onChainState: 'DisputedWithdrawn',
				collateralReturnLovelace: 0n,
				withdrawnForBuyer: [{ unit: 'policyasset', amount: 600n }],
			}),
		);
		expect(result.returnedFunds).toEqual([{ unit: 'policyasset', amount: 600n }]);
		expect(result.netSpend).toEqual([
			{ unit: 'lovelace', amount: 100_300_000n },
			{ unit: 'policyasset', amount: 400n },
		]);
	});

	it('marks a disputed buyer payout with collateral as partial', () => {
		const result = calculateBuyerMetrics(
			metricInput({
				onChainState: 'DisputedWithdrawn',
				requestedFunds: [{ unit: 'policyasset', amount: 1_000n }],
				collateralReturnLovelace: 2_000_000n,
				withdrawnForBuyer: [
					{ unit: 'lovelace', amount: 2_000_000n },
					{ unit: 'policyasset', amount: 600n },
				],
			}),
		);

		expect(result.returnedFunds).toBeNull();
		expect(result.netSpend).toBeNull();
	});

	it('returns null for incomplete disputed buyer payout data', () => {
		expect(
			calculateBuyerMetrics(metricInput({ onChainState: 'DisputedWithdrawn', buyerPayoutCompleteness: 'partial' }))
				.netSpend,
		).toBeNull();
	});

	it.each(['RefundWithdrawn', 'DisputedWithdrawn'] as const)(
		'returns partial terminal buyer values for %s without exact current-state evidence',
		(onChainState) => {
			const result = calculateBuyerMetrics(metricInput({ onChainState, hasConfirmedCurrentStateTransaction: false }));
			expect(result.returnedFunds).toBeNull();
			expect(result.netSpend).toBeNull();
		},
	);
});

describe('reconcileCardanoFees', () => {
	it('assigns the actor difference to admin fees for a complete allocation', () => {
		expect(
			reconcileCardanoFees({
				buyerCardanoFees: 300_000n,
				sellerCardanoFees: 200_000n,
				allocatedTotalCardanoFees: 600_000n,
				isAllocationComplete: true,
			}),
		).toEqual({
			buyerCardanoFees: 300_000n,
			sellerCardanoFees: 200_000n,
			adminCardanoFees: 100_000n,
			totalCardanoFees: 600_000n,
			completeness: 'complete',
		});
	});

	it('marks a shared allocation as partial', () => {
		expect(
			reconcileCardanoFees({
				buyerCardanoFees: 300_000n,
				sellerCardanoFees: 200_000n,
				allocatedTotalCardanoFees: null,
				isAllocationComplete: false,
			}),
		).toEqual({
			buyerCardanoFees: 300_000n,
			sellerCardanoFees: 200_000n,
			adminCardanoFees: null,
			totalCardanoFees: null,
			completeness: 'partial',
		});
	});

	it('marks actor totals above the allocation as inconsistent', () => {
		expect(
			reconcileCardanoFees({
				buyerCardanoFees: 300_000n,
				sellerCardanoFees: 200_000n,
				allocatedTotalCardanoFees: 400_000n,
				isAllocationComplete: true,
			}),
		).toMatchObject({
			adminCardanoFees: null,
			totalCardanoFees: 400_000n,
			completeness: 'inconsistent',
		});
	});
});
