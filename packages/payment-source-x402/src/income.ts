import createHttpError from 'http-errors';
import { Network, X402PaymentDirection, X402PaymentStatus, prisma } from '@masumi/payment-core/db';
import {
	addToAllFundsMaps,
	type Fund,
	mapDailyFundsOutput,
	mapMonthlyFundsOutput,
	mapTotalFundsOutput,
	parseDateRange,
} from '@/utils/earnings-helpers';
import spacetime from 'spacetime';

/** CAIP-19-style unit key for earnings (matches Sokosumi CreditCost.unit). */
export function x402IncomeUnit(caip2Network: string, asset: string): string {
	const normalizedAsset = asset.trim().toLowerCase();
	if (!/^eip155:\d+$/.test(caip2Network)) {
		return `${caip2Network}:${normalizedAsset}`;
	}
	return `${caip2Network}/erc20:${normalizedAsset}`;
}

function getDayNumberLocal(date: Date, timeZone: string): string {
	const sp = spacetime.fromUnixSeconds(date.getTime() / 1000).goto(timeZone);
	return sp.format('{YYYY}-{MM}-{DD}');
}

function getMonthNumberLocal(date: Date, timeZone: string): string {
	const sp = spacetime.fromUnixSeconds(date.getTime() / 1000).goto(timeZone);
	return sp.format('{YYYY}-{MM}');
}

function attemptAmount(attempt: {
	amount: bigint;
	Settlement: { success: boolean; amount: bigint | null } | null;
}): bigint {
	if (attempt.Settlement?.success === true && attempt.Settlement.amount != null) {
		return attempt.Settlement.amount;
	}
	return attempt.amount;
}

function isSettledIncome(attempt: {
	direction: X402PaymentDirection;
	status: X402PaymentStatus;
	Settlement: { success: boolean } | null;
}): boolean {
	if (attempt.direction !== X402PaymentDirection.InboundSettle) {
		return false;
	}
	if (attempt.status === X402PaymentStatus.Settled || attempt.status === X402PaymentStatus.Replayed) {
		return attempt.Settlement?.success === true;
	}
	return false;
}

function isPendingIncome(attempt: {
	direction: X402PaymentDirection;
	status: X402PaymentStatus;
	Settlement: { success: boolean } | null;
}): boolean {
	if (attempt.direction === X402PaymentDirection.InboundVerify) {
		return attempt.status === X402PaymentStatus.Verified;
	}
	if (attempt.direction === X402PaymentDirection.InboundSettle) {
		if (attempt.status === X402PaymentStatus.Verified) {
			return true;
		}
		if (attempt.status === X402PaymentStatus.Settled && attempt.Settlement == null) {
			return true;
		}
	}
	return false;
}

function isRefundedIncome(attempt: { status: X402PaymentStatus }): boolean {
	return attempt.status === X402PaymentStatus.Failed;
}

/**
 * Seller-side x402 income for one registry agent (`RegistryRequest.agentIdentifier`).
 * Counts inbound verify/settle attempts linked to that agent's registry row or
 * supported payment sources. Payments that never touch this node (fully external)
 * do not appear here.
 */
export async function getX402AgentPaymentIncome(input: {
	network: Network;
	agentIdentifier: string;
	startDate: Date | null | undefined;
	endDate: Date | null | undefined;
	timeZone: string;
}) {
	if (!input.agentIdentifier.trim()) {
		throw createHttpError(400, 'agentIdentifier is required for x402 income');
	}

	const { periodStart, periodEnd } = parseDateRange(input.startDate, input.endDate);

	const registryRows = await prisma.registryRequest.findMany({
		where: {
			agentIdentifier: input.agentIdentifier,
			PaymentSource: { network: input.network, deletedAt: null },
		},
		select: {
			id: true,
			SupportedPaymentSources: { select: { id: true } },
		},
	});

	if (registryRows.length === 0) {
		return emptyX402IncomeResponse(input.agentIdentifier, periodStart, periodEnd);
	}

	const registryRequestIds = registryRows.map((row) => row.id);
	const supportedPaymentSourceIds = registryRows.flatMap((row) =>
		row.SupportedPaymentSources.map((source) => source.id),
	);

	const attempts = await prisma.x402PaymentAttempt.findMany({
		where: {
			createdAt: { gte: periodStart, lte: periodEnd },
			OR: [
				{ registryRequestId: { in: registryRequestIds } },
				...(supportedPaymentSourceIds.length > 0
					? [{ supportedPaymentSourceId: { in: supportedPaymentSourceIds } }]
					: []),
			],
		},
		orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
		select: {
			id: true,
			createdAt: true,
			direction: true,
			status: true,
			asset: true,
			amount: true,
			Network: { select: { caip2Id: true } },
			Settlement: { select: { success: true, amount: true } },
		},
	});

	const totalIncomeMap: Fund = { units: new Map(), blockchainFees: 0n };
	const totalRefundedMap: Fund = { units: new Map(), blockchainFees: 0n };
	const totalPendingMap: Fund = { units: new Map(), blockchainFees: 0n };
	const dayIncomeMap = new Map<string, Fund>();
	const dayRefundedMap = new Map<string, Fund>();
	const dayPendingMap = new Map<string, Fund>();
	const monthlyIncomeMap = new Map<string, Fund>();
	const monthlyRefundedMap = new Map<string, Fund>();
	const monthlyPendingMap = new Map<string, Fund>();

	let incomeTxCount = 0;

	for (const attempt of attempts) {
		const dayDateLocal = getDayNumberLocal(attempt.createdAt, input.timeZone);
		const monthDateLocal = getMonthNumberLocal(attempt.createdAt, input.timeZone);
		const unit = x402IncomeUnit(attempt.Network.caip2Id, attempt.asset);
		const amount = attemptAmount(attempt);
		const units = [{ unit, amount }];

		if (isSettledIncome(attempt)) {
			incomeTxCount += 1;
			addToAllFundsMaps(totalIncomeMap, dayIncomeMap, monthlyIncomeMap, dayDateLocal, monthDateLocal, units, 0n);
		} else if (isRefundedIncome(attempt)) {
			addToAllFundsMaps(totalRefundedMap, dayRefundedMap, monthlyRefundedMap, dayDateLocal, monthDateLocal, units, 0n);
		} else if (isPendingIncome(attempt)) {
			addToAllFundsMaps(totalPendingMap, dayPendingMap, monthlyPendingMap, dayDateLocal, monthDateLocal, units, 0n);
		}
	}

	return {
		agentIdentifier: input.agentIdentifier,
		periodStart,
		periodEnd,
		totalTransactions: incomeTxCount,
		TotalIncome: mapTotalFundsOutput(totalIncomeMap),
		TotalRefunded: mapTotalFundsOutput(totalRefundedMap),
		TotalPending: mapTotalFundsOutput(totalPendingMap),
		DailyIncome: mapDailyFundsOutput(dayIncomeMap),
		DailyRefunded: mapDailyFundsOutput(dayRefundedMap),
		DailyPending: mapDailyFundsOutput(dayPendingMap),
		MonthlyIncome: mapMonthlyFundsOutput(monthlyIncomeMap),
		MonthlyRefunded: mapMonthlyFundsOutput(monthlyRefundedMap),
		MonthlyPending: mapMonthlyFundsOutput(monthlyPendingMap),
	};
}

function emptyX402IncomeResponse(agentIdentifier: string, periodStart: Date, periodEnd: Date) {
	const empty = mapTotalFundsOutput({ units: new Map(), blockchainFees: 0n });
	return {
		agentIdentifier,
		periodStart,
		periodEnd,
		totalTransactions: 0,
		TotalIncome: empty,
		TotalRefunded: empty,
		TotalPending: empty,
		DailyIncome: [],
		DailyRefunded: [],
		DailyPending: [],
		MonthlyIncome: [],
		MonthlyRefunded: [],
		MonthlyPending: [],
	};
}
