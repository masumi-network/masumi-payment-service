import { PaymentSourceType } from '@/generated/prisma/client';
import { CONFIG } from '@masumi/payment-core/config';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import createHttpError from 'http-errors';
import type { ReportPaymentSourceType } from './metrics';
import type { ReportQueryFilters } from './query';

export type ReportRoleCursor = { createdAt: Date; id: string };
export type ReportCursorPositions = { Buyer: ReportRoleCursor | null; Seller: ReportRoleCursor | null };
export type ReportCursorSnapshot = {
	asOf: Date;
	paymentSourceId: string;
	paymentSourceType: ReportPaymentSourceType;
	feeRatePermille: number;
	filterFingerprint: string;
};
export type DecodedReportCursor = {
	positions: ReportCursorPositions;
	snapshot: ReportCursorSnapshot | null;
};
export type ReportFilterFingerprintInput = Pick<
	ReportQueryFilters,
	| 'paymentSourceId'
	| 'authorizedManagedWalletIds'
	| 'externalAddresses'
	| 'roles'
	| 'states'
	| 'from'
	| 'to'
	| 'dateBasis'
	| 'revenueMode'
> & { timeZone: string };

type SerializedRoleCursor = { createdAt: string; id: string };
type SerializedReportCursor = {
	version: 2;
	positions: { Buyer: SerializedRoleCursor | null; Seller: SerializedRoleCursor | null };
	snapshot: {
		asOf: string;
		paymentSourceId: string;
		paymentSourceType: ReportPaymentSourceType;
		feeRatePermille: number;
		filterFingerprint: string;
	};
};

const REPORT_CURSOR_MAX_LENGTH = 16_384;
const EMPTY_REPORT_CURSOR_POSITIONS: ReportCursorPositions = { Buyer: null, Seller: null };
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const SHA256_BASE64URL_LENGTH = 43;

function sortedUnique(values: readonly string[]): string[] {
	return Array.from(new Set(values)).sort();
}

export function createReportFilterFingerprint(input: ReportFilterFingerprintInput): string {
	const canonical = {
		paymentSourceId: input.paymentSourceId,
		authorizedManagedWalletIds:
			input.authorizedManagedWalletIds == null ? null : sortedUnique(input.authorizedManagedWalletIds),
		externalAddresses: sortedUnique(input.externalAddresses),
		roles: sortedUnique(input.roles),
		states: sortedUnique(input.states),
		from: input.from.toISOString(),
		to: input.to.toISOString(),
		dateBasis: input.dateBasis,
		revenueMode: input.revenueMode,
		timeZone: input.timeZone,
	};
	return createHash('sha256').update(JSON.stringify(canonical)).digest('base64url');
}

export function createReportCursorSnapshot(
	filters: ReportQueryFilters,
	filterFingerprint: string,
): ReportCursorSnapshot {
	return {
		asOf: filters.asOf,
		paymentSourceId: filters.paymentSourceId,
		paymentSourceType: filters.paymentSourceType,
		feeRatePermille: filters.configuredFeeRatePermille,
		filterFingerprint,
	};
}

function cursorSignature(payload: string): Buffer {
	return createHmac('sha256', CONFIG.ENCRYPTION_KEY).update(payload).digest();
}

export function encodeReportCursor(cursor: {
	positions: ReportCursorPositions;
	snapshot: ReportCursorSnapshot;
}): string {
	const serialized: SerializedReportCursor = {
		version: 2,
		positions: serializeCursorPositions(cursor.positions),
		snapshot: {
			asOf: cursor.snapshot.asOf.toISOString(),
			paymentSourceId: cursor.snapshot.paymentSourceId,
			paymentSourceType: cursor.snapshot.paymentSourceType,
			feeRatePermille: cursor.snapshot.feeRatePermille,
			filterFingerprint: cursor.snapshot.filterFingerprint,
		},
	};
	const payload = Buffer.from(JSON.stringify(serialized)).toString('base64url');
	return `${payload}.${cursorSignature(payload).toString('base64url')}`;
}

function serializeCursorPositions(positions: ReportCursorPositions) {
	const encode = (cursor: ReportRoleCursor | null): SerializedRoleCursor | null =>
		cursor == null ? null : { createdAt: cursor.createdAt.toISOString(), id: cursor.id };
	return { Buyer: encode(positions.Buyer), Seller: encode(positions.Seller) };
}

function parseRoleCursor(value: unknown): ReportRoleCursor | null {
	if (value == null) return null;
	if (typeof value !== 'object' || Array.isArray(value)) throw createHttpError(400, 'Invalid report cursor');
	const candidate = value as { createdAt?: unknown; id?: unknown };
	if (typeof candidate.createdAt !== 'string' || typeof candidate.id !== 'string' || candidate.id.length === 0) {
		throw createHttpError(400, 'Invalid report cursor');
	}
	const createdAt = new Date(candidate.createdAt);
	if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== candidate.createdAt) {
		throw createHttpError(400, 'Invalid report cursor');
	}
	return { createdAt, id: candidate.id };
}

function parseCursorSnapshot(value: unknown): ReportCursorSnapshot {
	if (typeof value !== 'object' || value == null || Array.isArray(value)) {
		throw createHttpError(400, 'Invalid report cursor');
	}
	const candidate = value as {
		asOf?: unknown;
		paymentSourceId?: unknown;
		paymentSourceType?: unknown;
		feeRatePermille?: unknown;
		filterFingerprint?: unknown;
	};
	if (
		typeof candidate.asOf !== 'string' ||
		typeof candidate.paymentSourceId !== 'string' ||
		candidate.paymentSourceId.length === 0 ||
		(candidate.paymentSourceType !== PaymentSourceType.Web3CardanoV1 &&
			candidate.paymentSourceType !== PaymentSourceType.Web3CardanoV2) ||
		typeof candidate.feeRatePermille !== 'number' ||
		!Number.isSafeInteger(candidate.feeRatePermille) ||
		candidate.feeRatePermille < 0 ||
		typeof candidate.filterFingerprint !== 'string' ||
		candidate.filterFingerprint.length !== SHA256_BASE64URL_LENGTH ||
		!BASE64URL_PATTERN.test(candidate.filterFingerprint)
	) {
		throw createHttpError(400, 'Invalid report cursor');
	}
	const asOf = new Date(candidate.asOf);
	if (Number.isNaN(asOf.getTime()) || asOf.toISOString() !== candidate.asOf) {
		throw createHttpError(400, 'Invalid report cursor');
	}
	return {
		asOf,
		paymentSourceId: candidate.paymentSourceId,
		paymentSourceType: candidate.paymentSourceType,
		feeRatePermille: candidate.feeRatePermille,
		filterFingerprint: candidate.filterFingerprint,
	};
}

function parseSignedCursor(value: string): unknown {
	if (value.length > REPORT_CURSOR_MAX_LENGTH) throw createHttpError(400, 'Invalid report cursor');
	const parts = value.split('.');
	if (
		parts.length !== 2 ||
		parts[0].length === 0 ||
		parts[1].length === 0 ||
		!BASE64URL_PATTERN.test(parts[0]) ||
		!BASE64URL_PATTERN.test(parts[1])
	) {
		throw createHttpError(400, 'Invalid report cursor');
	}
	const actualSignature = Buffer.from(parts[1], 'base64url');
	const expectedSignature = cursorSignature(parts[0]);
	if (actualSignature.length !== expectedSignature.length || !timingSafeEqual(actualSignature, expectedSignature)) {
		throw createHttpError(400, 'Invalid report cursor');
	}
	return JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as unknown;
}

export function decodeReportCursor(value: string | undefined): DecodedReportCursor {
	if (value == null) return { positions: { ...EMPTY_REPORT_CURSOR_POSITIONS }, snapshot: null };
	try {
		const parsed = parseSignedCursor(value);
		if (typeof parsed !== 'object' || parsed == null || Array.isArray(parsed)) {
			throw createHttpError(400, 'Invalid report cursor');
		}
		const candidate = parsed as { version?: unknown; positions?: unknown; snapshot?: unknown };
		if (
			candidate.version !== 2 ||
			typeof candidate.positions !== 'object' ||
			candidate.positions == null ||
			Array.isArray(candidate.positions)
		) {
			throw createHttpError(400, 'Invalid report cursor');
		}
		const positions = candidate.positions as { Buyer?: unknown; Seller?: unknown };
		if (!('Buyer' in positions) || !('Seller' in positions)) {
			throw createHttpError(400, 'Invalid report cursor');
		}
		return {
			positions: { Buyer: parseRoleCursor(positions.Buyer), Seller: parseRoleCursor(positions.Seller) },
			snapshot: parseCursorSnapshot(candidate.snapshot),
		};
	} catch (error) {
		if (createHttpError.isHttpError(error)) throw error;
		throw createHttpError(400, 'Invalid report cursor');
	}
}
