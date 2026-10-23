import { MAX_HYDRA_QUANTITY } from '@/lib/hydra/hydra/schemas';

/**
 * The shape of an amount that has to move something.
 *
 * `/^\d+$/` also matches `"0"`, and a zero amount is not a rejected request —
 * it is an accepted one that builds nothing. A zero withdrawal is treated as an
 * exact amount, `coverLovelace` reports it already covered and returns no
 * inputs, and the decommit is then built with an empty input set — after the
 * endpoint has already answered `accepted: true`. A zero commit and a zero
 * top-up carve nothing the same way.
 *
 * Leading zeros go with it, so one amount has one spelling.
 */
export const POSITIVE_BASE_UNIT_AMOUNT = /^[1-9]\d*$/;

/** Says what the regex above wants, in the terms the caller sent. */
export const POSITIVE_BASE_UNIT_AMOUNT_MESSAGE =
	'Must be a positive integer in the asset base unit, without leading zeros';

/** The largest value a BigInt column holds. */
export const MAX_DATABASE_BIGINT = 9_223_372_036_854_775_807n;

/**
 * Whether a digit string is no larger than `max`.
 *
 * A refinement, not a parse: Zod runs it even after the regex beside it has
 * failed, and `BigInt('abc')` throws, which answers 500. The length check keeps a
 * huge string from being parsed at all.
 */
function isWithinLimit(value: string, max: bigint): boolean {
	return value.length <= max.toString().length && /^\d+$/.test(value) && BigInt(value) <= max;
}

/**
 * An amount that is written to a BigInt column. Past the limit it used to be
 * accepted, then fail in the write, and the driver's message and a server path
 * were stored as the reason.
 */
export const withinDatabaseAmount = (value: string): boolean => isWithinLimit(value, MAX_DATABASE_BIGINT);
export const DATABASE_AMOUNT_MESSAGE = `Must not exceed ${MAX_DATABASE_BIGINT}`;

/** A token amount, which only the ledger limits: it is held as text. */
export const withinHydraQuantity = (value: string): boolean => isWithinLimit(value, MAX_HYDRA_QUANTITY);
export const HYDRA_QUANTITY_MESSAGE = `Must not exceed ${MAX_HYDRA_QUANTITY}`;
