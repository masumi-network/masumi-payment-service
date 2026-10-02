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
import { normalizeAddress } from './internal';

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
	if (attempt.direction === X402PaymentDirection.OutboundPayment) {
		// Masumi hire (POST /x402/pay): successful sign is Verified on the payment node.
		return (
			attempt.status === X402PaymentStatus.Verified ||
			attempt.status === X402PaymentStatus.Settled ||
			attempt.status === X402PaymentStatus.Replayed
		);
	}
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
	if (attempt.direction === X402PaymentDirection.OutboundPayment) {
		return attempt.status === X402PaymentStatus.PaymentRequired;
	}
	return false;
}

function isRefundedIncome(attempt: { status: X402PaymentStatus }): boolean {
	return attempt.status === X402PaymentStatus.Failed;
}

/** @internal Unit tests for inbound settle vs Masumi hire outbound classification. */
export function classifyX402AttemptForEarnings(attempt: {
	direction: X402PaymentDirection;
	status: X402PaymentStatus;
	Settlement: { success: boolean } | null;
}): 'income' | 'refunded' | 'pending' | null {
	if (isSettledIncome(attempt)) return 'income';
	if (isRefundedIncome(attempt)) return 'refunded';
	if (isPendingIncome(attempt)) return 'pending';
	return null;
}

function receiveAddressFromSupportedSource(source: { payTo: string | null; address: string }): string | null {
	const raw = source.payTo?.trim() || source.address.trim();
	if (raw === '') return null;
	return normalizeAddress(raw);
}

type X402AgentEarningsScope = {
	registryRequestIds: string[];
	supportedPaymentSourceIds: string[];
	/** Masumi hire outbound match when this agent is the only registry row for the payTo. */
	soleOwnerOutboundPayTos: string[];
	/** Shared payTo rows: match outbound attempts by registered resource URL as well. */
	sharedOutboundPayTos: string[];
	protectedResources: string[];
};

async function resolveOutboundPayToScope(
	agentIdentifier: string,
	network: Network,
	candidatePayTos: string[],
): Promise<Pick<X402AgentEarningsScope, 'soleOwnerOutboundPayTos' | 'sharedOutboundPayTos'>> {
	if (candidatePayTos.length === 0) {
		return { soleOwnerOutboundPayTos: [], sharedOutboundPayTos: [] };
	}

	const sources = await prisma.supportedPaymentSource.findMany({
		where: {
			chain: 'EVM',
			RegistryRequest: {
				PaymentSource: { network, deletedAt: null },
				agentIdentifier: { not: null },
			},
		},
		select: {
			payTo: true,
			address: true,
			RegistryRequest: { select: { agentIdentifier: true } },
		},
	});

	const ownersByReceiveAddress = new Map<string, Set<string>>();
	for (const source of sources) {
		const receiveAddress = receiveAddressFromSupportedSource(source);
		if (receiveAddress == null || !candidatePayTos.includes(receiveAddress)) {
			continue;
		}
		const ownerId = source.RegistryRequest.agentIdentifier;
		if (ownerId == null) {
			continue;
		}
		const owners = ownersByReceiveAddress.get(receiveAddress) ?? new Set<string>();
		owners.add(ownerId);
		ownersByReceiveAddress.set(receiveAddress, owners);
	}

	const soleOwnerOutboundPayTos: string[] = [];
	const sharedOutboundPayTos: string[] = [];
	for (const payTo of candidatePayTos) {
		const owners = ownersByReceiveAddress.get(payTo);
		if (owners?.size === 1 && owners.has(agentIdentifier)) {
			soleOwnerOutboundPayTos.push(payTo);
		} else if (owners != null && owners.has(agentIdentifier)) {
			sharedOutboundPayTos.push(payTo);
		}
	}

	return { soleOwnerOutboundPayTos, sharedOutboundPayTos };
}

async function resolveX402AgentEarningsScope(input: {
	network: Network;
	agentIdentifier: string;
}): Promise<X402AgentEarningsScope | null> {
	const registryRows = await prisma.registryRequest.findMany({
		where: {
			agentIdentifier: input.agentIdentifier,
			PaymentSource: { network: input.network, deletedAt: null },
		},
		select: {
			id: true,
			SupportedPaymentSources: {
				select: { id: true, payTo: true, address: true, resource: true },
			},
		},
	});

	if (registryRows.length === 0) {
		return null;
	}

	const registryRequestIds = registryRows.map((row) => row.id);
	const supportedPaymentSourceIds = registryRows.flatMap((row) =>
		row.SupportedPaymentSources.map((source) => source.id),
	);
	const candidatePayTos = [
		...new Set(
			registryRows
				.flatMap((row) => row.SupportedPaymentSources.map((source) => receiveAddressFromSupportedSource(source)))
				.filter((payTo): payTo is string => payTo != null),
		),
	];
	const protectedResources = [
		...new Set(
			registryRows
				.flatMap((row) => row.SupportedPaymentSources.map((source) => source.resource?.trim() ?? ''))
				.filter((resource) => resource !== ''),
		),
	];
	const outboundPayToScope = await resolveOutboundPayToScope(input.agentIdentifier, input.network, candidatePayTos);

	return {
		registryRequestIds,
		supportedPaymentSourceIds,
		protectedResources,
		...outboundPayToScope,
	};
}

function x402AgentAttemptsWhere(scope: X402AgentEarningsScope, periodStart: Date, periodEnd: Date) {
	const outboundClauses = [
		...(scope.soleOwnerOutboundPayTos.length > 0
			? [
					{
						direction: X402PaymentDirection.OutboundPayment,
						payTo: { in: scope.soleOwnerOutboundPayTos },
					},
				]
			: []),
		...(scope.sharedOutboundPayTos.length > 0 && scope.protectedResources.length > 0
			? [
					{
						direction: X402PaymentDirection.OutboundPayment,
						payTo: { in: scope.sharedOutboundPayTos },
						resource: { in: scope.protectedResources },
					},
				]
			: []),
	];

	return {
		createdAt: { gte: periodStart, lte: periodEnd },
		OR: [
			{ registryRequestId: { in: scope.registryRequestIds } },
			...(scope.supportedPaymentSourceIds.length > 0
				? [{ supportedPaymentSourceId: { in: scope.supportedPaymentSourceIds } }]
				: []),
			...outboundClauses,
		],
	};
}

const X402_AGENT_ACTIVITY_SELECT = {
	id: true,
	createdAt: true,
	direction: true,
	status: true,
	asset: true,
	amount: true,
	payTo: true,
	Network: { select: { caip2Id: true } },
	Settlement: { select: { success: true, txHash: true, amount: true } },
} as const;

/**
 * Agent-scoped x402 payment attempts for dashboards (not tenant apiKey-scoped).
 * Matches the same registry / payTo scope as {@link getX402AgentPaymentIncome}.
 */
export async function listX402AgentPaymentActivity(input: {
	network: Network;
	agentIdentifier: string;
	startDate: Date | null | undefined;
	endDate: Date | null | undefined;
	take?: number;
}) {
	if (!input.agentIdentifier.trim()) {
		throw createHttpError(400, 'agentIdentifier is required for x402 activity');
	}

	const { periodStart, periodEnd } = parseDateRange(input.startDate, input.endDate);
	const scope = await resolveX402AgentEarningsScope({
		network: input.network,
		agentIdentifier: input.agentIdentifier,
	});

	if (scope == null) {
		return {
			agentIdentifier: input.agentIdentifier,
			periodStart,
			periodEnd,
			Attempts: [],
		};
	}

	const take = Math.min(Math.max(input.take ?? 50, 1), 100);
	const attempts = await prisma.x402PaymentAttempt.findMany({
		where: x402AgentAttemptsWhere(scope, periodStart, periodEnd),
		orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
		take,
		select: X402_AGENT_ACTIVITY_SELECT,
	});

	return {
		agentIdentifier: input.agentIdentifier,
		periodStart,
		periodEnd,
		Attempts: attempts.map((attempt) => ({
			id: attempt.id,
			createdAt: attempt.createdAt,
			direction: attempt.direction,
			status: attempt.status,
			caip2Network: attempt.Network.caip2Id,
			asset: attempt.asset,
			amount: attempt.amount.toString(),
			payTo: attempt.payTo,
			txHash: attempt.Settlement?.txHash ?? null,
			settlementSuccess: attempt.Settlement?.success ?? null,
		})),
	};
}

/**
 * x402 earnings for one registry agent (`RegistryRequest.agentIdentifier`) on this node.
 * Includes seller inbound settle and Masumi hire/pay (outbound Verified) when payTo
 * matches a registered supported payment source. Fully external pays with no row here
 * do not appear.
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

	const scope = await resolveX402AgentEarningsScope({
		network: input.network,
		agentIdentifier: input.agentIdentifier,
	});

	if (scope == null) {
		return emptyX402IncomeResponse(input.agentIdentifier, periodStart, periodEnd);
	}

	const attempts = await prisma.x402PaymentAttempt.findMany({
		where: x402AgentAttemptsWhere(scope, periodStart, periodEnd),
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

		const bucket = classifyX402AttemptForEarnings(attempt);
		if (bucket === 'income') {
			incomeTxCount += 1;
			addToAllFundsMaps(totalIncomeMap, dayIncomeMap, monthlyIncomeMap, dayDateLocal, monthDateLocal, units, 0n);
		} else if (bucket === 'refunded') {
			addToAllFundsMaps(totalRefundedMap, dayRefundedMap, monthlyRefundedMap, dayDateLocal, monthDateLocal, units, 0n);
		} else if (bucket === 'pending') {
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
