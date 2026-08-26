import { CONSTANTS } from '@masumi/payment-core/config';
import {
	addAmounts,
	cardanoFeeAmount,
	getAtomicAmount,
	normalizeAmounts,
	subtractAmounts,
	type AtomicAmount,
} from './amounts';

export type ReportOnChainState =
	| 'FundsLocked'
	| 'FundsOrDatumInvalid'
	| 'ResultSubmitted'
	| 'RefundRequested'
	| 'Disputed'
	| 'WithdrawAuthorized'
	| 'RefundAuthorized'
	| 'Withdrawn'
	| 'RefundWithdrawn'
	| 'DisputedWithdrawn';

export type RevenueMode = 'Billable' | 'CashReceived' | 'RequestedGross';
export type ReportPaymentSourceType = 'Web3CardanoV1' | 'Web3CardanoV2';
export type PayoutCompleteness = 'complete' | 'partial';

export type ReportMetricInput = {
	onChainState: ReportOnChainState | null;
	paymentSourceType: ReportPaymentSourceType;
	configuredFeeRatePermille: number;
	unlockTime: bigint;
	asOfTime: bigint;
	hasConfirmedFundsLockedTransaction: boolean;
	hasConfirmedCurrentStateTransaction: boolean;
	requestedFunds: readonly AtomicAmount[];
	withdrawnForBuyer: readonly AtomicAmount[];
	withdrawnForSeller: readonly AtomicAmount[];
	buyerPayoutCompleteness: PayoutCompleteness;
	sellerPayoutCompleteness: PayoutCompleteness;
	collateralReturnLovelace: bigint | null;
	buyerCardanoFees: bigint;
	sellerCardanoFees: bigint;
};

export type ProtocolFee = {
	configuredRatePermille: number;
	appliedRatePermille: number | null;
	amounts: AtomicAmount[] | null;
	provenance: 'calculated' | 'projected' | 'exact_zero' | 'not_applicable' | 'insufficient_data';
	basis: 'stored_requested_plus_collateral' | 'contract_version' | null;
	completeness: 'exact' | 'reconstructed' | 'not_applicable' | 'insufficient_data';
};

function isProtocolFeeApplicable(input: ReportMetricInput, revenueMode: RevenueMode): boolean {
	if (input.onChainState === 'Withdrawn') return true;
	return revenueMode === 'Billable' && input.onChainState === 'ResultSubmitted' && input.unlockTime <= input.asOfTime;
}

function validateFeeRate(configuredFeeRatePermille: number): void {
	if (
		!Number.isInteger(configuredFeeRatePermille) ||
		configuredFeeRatePermille < 0 ||
		configuredFeeRatePermille > 1000
	) {
		throw new RangeError('configuredFeeRatePermille must be an integer from 0 through 1000');
	}
}

function validateNonNegativeAmounts(values: readonly AtomicAmount[], fieldName: string): void {
	if (values.some((value) => value.amount < 0n)) {
		throw new RangeError(`${fieldName} must not be negative`);
	}
}

function insufficientProtocolFee(
	configuredRatePermille: number,
	appliedRatePermille: number | null = configuredRatePermille,
): ProtocolFee {
	return {
		configuredRatePermille,
		appliedRatePermille,
		amounts: null,
		provenance: 'insufficient_data',
		basis: null,
		completeness: 'insufficient_data',
	};
}

export function getSellerGrossRevenue(input: ReportMetricInput, revenueMode: RevenueMode): AtomicAmount[] | null {
	validateNonNegativeAmounts(input.requestedFunds, 'requested funds');
	const requestedFunds = normalizeAmounts(input.requestedFunds);
	if (revenueMode === 'RequestedGross') return requestedFunds;

	if (input.onChainState === 'Withdrawn') {
		return input.hasConfirmedCurrentStateTransaction ? requestedFunds : null;
	}
	if (input.onChainState === 'DisputedWithdrawn') {
		if (!input.hasConfirmedCurrentStateTransaction) return null;
		validateNonNegativeAmounts(input.withdrawnForSeller, 'seller withdrawn funds');
		return input.sellerPayoutCompleteness === 'complete' ? normalizeAmounts(input.withdrawnForSeller) : null;
	}
	if (revenueMode === 'Billable' && input.onChainState === 'ResultSubmitted' && input.unlockTime <= input.asOfTime) {
		return input.hasConfirmedCurrentStateTransaction ? requestedFunds : null;
	}
	return [];
}

export function calculateProtocolFee(input: ReportMetricInput, revenueMode: RevenueMode): ProtocolFee {
	validateFeeRate(input.configuredFeeRatePermille);
	if (!isProtocolFeeApplicable(input, revenueMode)) {
		return {
			configuredRatePermille: input.configuredFeeRatePermille,
			appliedRatePermille: null,
			amounts: null,
			provenance: 'not_applicable',
			basis: null,
			completeness: 'not_applicable',
		};
	}
	if (!input.hasConfirmedCurrentStateTransaction) {
		return insufficientProtocolFee(input.configuredFeeRatePermille, null);
	}

	if (input.paymentSourceType === 'Web3CardanoV2') {
		return {
			configuredRatePermille: input.configuredFeeRatePermille,
			appliedRatePermille: 0,
			amounts: [],
			provenance: 'exact_zero',
			basis: 'contract_version',
			completeness: 'exact',
		};
	}

	if (input.collateralReturnLovelace == null) {
		return insufficientProtocolFee(input.configuredFeeRatePermille);
	}
	if (input.collateralReturnLovelace < 0n) {
		throw new RangeError('collateralReturnLovelace must not be negative');
	}

	validateNonNegativeAmounts(input.requestedFunds, 'requested funds');
	const lockedAmounts = addAmounts(input.requestedFunds, cardanoFeeAmount(input.collateralReturnLovelace));
	if (getAtomicAmount(lockedAmounts, 'lovelace') === 0n) {
		return insufficientProtocolFee(input.configuredFeeRatePermille);
	}

	const amounts = normalizeAmounts(
		lockedAmounts.map((value) => {
			const proportionalFee = (value.amount * BigInt(input.configuredFeeRatePermille)) / 1000n;
			const amount =
				value.unit === 'lovelace' && proportionalFee < CONSTANTS.MIN_COLLATERAL_LOVELACE
					? CONSTANTS.MIN_COLLATERAL_LOVELACE
					: proportionalFee;
			return { unit: value.unit, amount };
		}),
	);

	return {
		configuredRatePermille: input.configuredFeeRatePermille,
		appliedRatePermille: input.configuredFeeRatePermille,
		amounts,
		provenance: input.onChainState === 'Withdrawn' ? 'calculated' : 'projected',
		basis: 'stored_requested_plus_collateral',
		completeness: 'reconstructed',
	};
}

export function calculateSellerMetrics(input: ReportMetricInput, revenueMode: RevenueMode) {
	if (input.sellerCardanoFees < 0n) throw new RangeError('seller Cardano fees must not be negative');
	const grossRevenue = getSellerGrossRevenue(input, revenueMode);
	const protocolFee = calculateProtocolFee(input, revenueMode);
	const cardanoFees = cardanoFeeAmount(input.sellerCardanoFees);
	const hasUnknownProtocolFee = protocolFee.completeness === 'insufficient_data';
	const netRevenue =
		grossRevenue == null || hasUnknownProtocolFee
			? null
			: subtractAmounts(grossRevenue, protocolFee.amounts ?? [], cardanoFees);
	return { grossRevenue, protocolFee, cardanoFees, netRevenue };
}

export function calculateBuyerMetrics(input: ReportMetricInput) {
	validateNonNegativeAmounts(input.requestedFunds, 'requested funds');
	validateNonNegativeAmounts(input.withdrawnForBuyer, 'buyer withdrawn funds');
	if (input.buyerCardanoFees < 0n) throw new RangeError('buyer Cardano fees must not be negative');
	if (input.collateralReturnLovelace != null && input.collateralReturnLovelace < 0n) {
		throw new RangeError('collateralReturnLovelace must not be negative');
	}
	const grossSpend =
		input.onChainState == null
			? []
			: input.onChainState === 'FundsOrDatumInvalid'
				? null
				: input.hasConfirmedFundsLockedTransaction
					? normalizeAmounts(input.requestedFunds)
					: null;

	let returnedFunds: AtomicAmount[] | null = [];
	if (input.onChainState === 'RefundWithdrawn') {
		returnedFunds = input.hasConfirmedCurrentStateTransaction ? normalizeAmounts(input.requestedFunds) : null;
	} else if (input.onChainState === 'DisputedWithdrawn') {
		returnedFunds =
			input.hasConfirmedCurrentStateTransaction &&
			input.buyerPayoutCompleteness === 'complete' &&
			input.collateralReturnLovelace === 0n
				? normalizeAmounts(input.withdrawnForBuyer)
				: null;
	}

	const cardanoFees = cardanoFeeAmount(input.buyerCardanoFees);
	const netSpend =
		grossSpend == null || returnedFunds == null
			? null
			: addAmounts(subtractAmounts(grossSpend, returnedFunds), cardanoFees);
	return { grossSpend, returnedFunds, cardanoFees, netSpend };
}

export function reconcileCardanoFees(input: {
	buyerCardanoFees: bigint;
	sellerCardanoFees: bigint;
	allocatedTotalCardanoFees: bigint | null;
	isAllocationComplete: boolean;
}) {
	if (
		input.buyerCardanoFees < 0n ||
		input.sellerCardanoFees < 0n ||
		(input.allocatedTotalCardanoFees != null && input.allocatedTotalCardanoFees < 0n)
	) {
		throw new RangeError('Cardano fees must not be negative');
	}
	const actorTotal = input.buyerCardanoFees + input.sellerCardanoFees;
	if (!input.isAllocationComplete || input.allocatedTotalCardanoFees == null) {
		return {
			buyerCardanoFees: input.buyerCardanoFees,
			sellerCardanoFees: input.sellerCardanoFees,
			adminCardanoFees: null,
			totalCardanoFees: null,
			completeness: 'partial' as const,
		};
	}
	if (input.allocatedTotalCardanoFees < actorTotal) {
		return {
			buyerCardanoFees: input.buyerCardanoFees,
			sellerCardanoFees: input.sellerCardanoFees,
			adminCardanoFees: null,
			totalCardanoFees: input.allocatedTotalCardanoFees,
			completeness: 'inconsistent' as const,
		};
	}
	return {
		buyerCardanoFees: input.buyerCardanoFees,
		sellerCardanoFees: input.sellerCardanoFees,
		adminCardanoFees: input.allocatedTotalCardanoFees - actorTotal,
		totalCardanoFees: input.allocatedTotalCardanoFees,
		completeness: 'complete' as const,
	};
}
