import { X402PaymentDirection, X402PaymentStatus, prisma } from '@masumi/payment-core/db';

export type X402UnitAmount = { caip2Network: string; asset: string; amount: string };
export type X402PeriodBuckets = {
	year: number;
	month: number;
	day?: number;
	Income: X402UnitAmount[];
	Spend: X402UnitAmount[];
};

const DEFAULT_WINDOW_DAYS = 30;

function resolveTimeZone(timeZone: string | undefined): string {
	if (timeZone == null) return 'Etc/UTC';
	try {
		new Intl.DateTimeFormat('en-CA', { timeZone });
		return timeZone;
	} catch {
		return 'Etc/UTC';
	}
}

function localYmd(date: Date, timeZone: string): { year: number; month: number; day: number } {
	const parts = new Intl.DateTimeFormat('en-CA', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	}).formatToParts(date);
	const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
	return { year: get('year'), month: get('month'), day: get('day') };
}

// Sum amounts keyed by (network, asset) inside a single bucket.
type UnitMap = Map<string, bigint>;
function addUnit(map: UnitMap, caip2Network: string, asset: string, amount: bigint) {
	const key = `${caip2Network}|${asset}`;
	map.set(key, (map.get(key) ?? 0n) + amount);
}
function unitsFromMap(map: UnitMap): X402UnitAmount[] {
	return Array.from(map.entries()).map(([key, amount]) => {
		const [caip2Network, asset] = key.split('|');
		return { caip2Network, asset, amount: amount.toString() };
	});
}

/**
 * Aggregates settled x402 flows for the dashboard: inbound settled payments (income, the
 * sell side) and outbound signed payments (spend, the buy side), bucketed by day and month
 * in the caller's timezone and split by (network, asset). Reads `X402PaymentAttempt` rows
 * directly — the same data the payments tab lists — so there is no separate ledger to keep
 * in sync.
 */
export async function getX402Analytics(input: {
	startDate?: Date | null;
	endDate?: Date | null;
	caip2Network?: string;
	timeZone?: string;
}) {
	const timeZone = resolveTimeZone(input.timeZone);
	const periodEnd = input.endDate ?? new Date();
	const periodStart = input.startDate ?? new Date(periodEnd.getTime() - DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000);

	const attempts = await prisma.x402PaymentAttempt.findMany({
		where: {
			createdAt: { gte: periodStart, lte: periodEnd },
			caip2Network: input.caip2Network,
			OR: [
				{ direction: X402PaymentDirection.InboundSettle, status: X402PaymentStatus.Settled },
				{
					direction: X402PaymentDirection.OutboundPayment,
					status: { in: [X402PaymentStatus.Verified, X402PaymentStatus.Settled] },
				},
			],
		},
		select: { createdAt: true, direction: true, caip2Network: true, asset: true, amount: true },
	});

	const totalIncome: UnitMap = new Map();
	const totalSpend: UnitMap = new Map();
	let incomeCount = 0;
	let spendCount = 0;
	// keyed by `${year}-${month}` and `${year}-${month}-${day}`
	const monthly = new Map<string, { year: number; month: number; Income: UnitMap; Spend: UnitMap }>();
	const daily = new Map<string, { year: number; month: number; day: number; Income: UnitMap; Spend: UnitMap }>();

	for (const attempt of attempts) {
		const isIncome = attempt.direction === X402PaymentDirection.InboundSettle;
		const { year, month, day } = localYmd(attempt.createdAt, timeZone);
		const monthKey = `${year}-${month}`;
		const dayKey = `${monthKey}-${day}`;
		if (!monthly.has(monthKey)) monthly.set(monthKey, { year, month, Income: new Map(), Spend: new Map() });
		if (!daily.has(dayKey)) daily.set(dayKey, { year, month, day, Income: new Map(), Spend: new Map() });
		const monthBucket = monthly.get(monthKey)!;
		const dayBucket = daily.get(dayKey)!;

		if (isIncome) {
			incomeCount += 1;
			addUnit(totalIncome, attempt.caip2Network, attempt.asset, attempt.amount);
			addUnit(monthBucket.Income, attempt.caip2Network, attempt.asset, attempt.amount);
			addUnit(dayBucket.Income, attempt.caip2Network, attempt.asset, attempt.amount);
		} else {
			spendCount += 1;
			addUnit(totalSpend, attempt.caip2Network, attempt.asset, attempt.amount);
			addUnit(monthBucket.Spend, attempt.caip2Network, attempt.asset, attempt.amount);
			addUnit(dayBucket.Spend, attempt.caip2Network, attempt.asset, attempt.amount);
		}
	}

	const sortByDate = <T extends { year: number; month: number; day?: number }>(rows: T[]) =>
		rows.sort((a, b) => a.year - b.year || a.month - b.month || (a.day ?? 0) - (b.day ?? 0));

	return {
		periodStart,
		periodEnd,
		incomeCount,
		spendCount,
		TotalIncome: unitsFromMap(totalIncome),
		TotalSpend: unitsFromMap(totalSpend),
		Daily: sortByDate(
			Array.from(daily.values()).map((bucket) => ({
				year: bucket.year,
				month: bucket.month,
				day: bucket.day,
				Income: unitsFromMap(bucket.Income),
				Spend: unitsFromMap(bucket.Spend),
			})),
		),
		Monthly: sortByDate(
			Array.from(monthly.values()).map((bucket) => ({
				year: bucket.year,
				month: bucket.month,
				Income: unitsFromMap(bucket.Income),
				Spend: unitsFromMap(bucket.Spend),
			})),
		),
	};
}
