/**
 * Calendar maths for report buckets.
 *
 * A report groups rows by day, week or month in the reader's own time zone, so
 * every bucket boundary is a local date rather than a UTC one. This module owns
 * reading a local date, finding the instant a local date starts, and stepping
 * from one bucket to the next.
 */
import type { ReportBucket, RequestedReportBucket } from './aggregate-types';

export type LocalDate = Readonly<{ year: number; month: number; day: number }>;

const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;
const DATE_BOUNDARY_SEARCH_HOURS = 36;

function assertValidRange(from: Date, to: Date): void {
	if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
		throw new RangeError('Report dates must be valid');
	}
	if (to.getTime() <= from.getTime()) throw new RangeError('Report to date must be after from date');
}

export function chooseReportBucket(from: Date, to: Date, requested: RequestedReportBucket = 'Auto'): ReportBucket {
	assertValidRange(from, to);
	if (requested !== 'Auto') return requested;
	const rangeMilliseconds = to.getTime() - from.getTime();
	if (rangeMilliseconds <= 30 * DAY_MILLISECONDS) return 'Day';
	if (rangeMilliseconds <= 366 * DAY_MILLISECONDS) return 'Week';
	return 'Month';
}

function localDateOrdinal(date: LocalDate): number {
	const value = new Date(0);
	value.setUTCFullYear(date.year, date.month - 1, date.day);
	value.setUTCHours(0, 0, 0, 0);
	return value.getTime();
}

function localDateFromOrdinal(ordinal: number): LocalDate {
	const value = new Date(ordinal);
	return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() };
}

export function createLocalDateReader(timeZone: string): (date: Date) => LocalDate {
	const formatter = new Intl.DateTimeFormat('en-CA', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	});
	return (date) => {
		const fields = new Map(
			formatter
				.formatToParts(date)
				.filter((part) => part.type !== 'literal')
				.map((part) => [part.type, Number(part.value)]),
		);
		const year = fields.get('year');
		const month = fields.get('month');
		const day = fields.get('day');
		if (year == null || month == null || day == null) throw new RangeError('Unable to read local report date');
		return { year, month, day };
	};
}

export function getBucketLocalStart(localDate: LocalDate, bucket: ReportBucket): LocalDate {
	if (bucket === 'Day') return localDate;
	if (bucket === 'Month') return { ...localDate, day: 1 };
	const ordinal = localDateOrdinal(localDate);
	const dayOfWeek = new Date(ordinal).getUTCDay();
	const daysSinceMonday = (dayOfWeek + 6) % 7;
	return localDateFromOrdinal(ordinal - daysSinceMonday * DAY_MILLISECONDS);
}

export function getNextBucketLocalStart(localDate: LocalDate, bucket: ReportBucket): LocalDate {
	if (bucket === 'Month') {
		return localDate.month === 12
			? { year: localDate.year + 1, month: 1, day: 1 }
			: { year: localDate.year, month: localDate.month + 1, day: 1 };
	}
	const dayCount = bucket === 'Day' ? 1 : 7;
	return localDateFromOrdinal(localDateOrdinal(localDate) + dayCount * DAY_MILLISECONDS);
}

export function findLocalDateStart(localDate: LocalDate, readLocalDate: (date: Date) => LocalDate): Date {
	const targetOrdinal = localDateOrdinal(localDate);
	let low = targetOrdinal - DATE_BOUNDARY_SEARCH_HOURS * 60 * 60 * 1000;
	let high = targetOrdinal + DATE_BOUNDARY_SEARCH_HOURS * 60 * 60 * 1000;
	while (localDateOrdinal(readLocalDate(new Date(low))) >= targetOrdinal) low -= DAY_MILLISECONDS;
	while (localDateOrdinal(readLocalDate(new Date(high))) < targetOrdinal) high += DAY_MILLISECONDS;

	while (high - low > 1) {
		const middle = low + Math.floor((high - low) / 2);
		if (localDateOrdinal(readLocalDate(new Date(middle))) >= targetOrdinal) high = middle;
		else low = middle;
	}
	return new Date(high);
}
