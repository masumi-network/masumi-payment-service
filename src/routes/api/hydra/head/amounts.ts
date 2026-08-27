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
