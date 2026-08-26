/**
 * How a Cardano network fee is shared between the requests one transaction settles.
 *
 * Cardano charges one fee per transaction, whatever number of requests that
 * transaction settles, and the chain records no breakdown. A batched fee is
 * therefore divided by a rule rather than read.
 *
 * The rule is an equal part per request in the batch. A transaction fee follows
 * the size of the transaction rather than the amounts being paid, so every
 * request in a batch costs about the same to settle. Sharing by amount would
 * read as precision the chain does not support.
 *
 * The parts add back up to the fee exactly, and the same inputs always give the
 * same parts, so a part is treated as that request's fee. Callers report it the
 * same way they report a fee a request paid on its own.
 */

/**
 * Divides a fee into equal parts that add back up to the fee exactly.
 *
 * Lovelace is indivisible, so a fee rarely divides evenly. The remainder goes
 * one lovelace at a time to the earliest shares, which keeps the total exact
 * and keeps the outcome the same on every run.
 */
export function splitFeeEvenly(fee: bigint, shareCount: number): bigint[] {
	if (!Number.isSafeInteger(shareCount) || shareCount <= 0) {
		throw new RangeError('A fee needs at least one share');
	}
	if (fee < 0n) throw new RangeError('A fee must not be negative');
	const count = BigInt(shareCount);
	const base = fee / count;
	const remainder = Number(fee % count);
	return Array.from({ length: shareCount }, (_unused, index) => (index < remainder ? base + 1n : base));
}

/** The batch a fee is shared across, in one fixed order on every run. */
function sortedBatch(paymentKeys: readonly string[]): string[] {
	return Array.from(new Set(paymentKeys)).sort((left, right) => left.localeCompare(right));
}

/**
 * One request's share of a transaction fee, or null when the request is not in
 * the batch and so owes none of it.
 */
export function feeShareForPaymentKey(fee: bigint, paymentKeys: readonly string[], paymentKey: string): bigint | null {
	const batch = sortedBatch(paymentKeys);
	const index = batch.indexOf(paymentKey);
	if (index < 0) return null;
	return splitFeeEvenly(fee, batch.length)[index];
}

/**
 * The part of a fee that belongs to a set of requests.
 *
 * A report can hold some requests of a batch and not others, because a filter
 * or a date range left the rest out. The report then owes only its own shares,
 * and the shares of the requests it cannot see stay outside the report.
 */
export function feeShareForPaymentKeys(
	fee: bigint,
	paymentKeys: readonly string[],
	selectedPaymentKeys: ReadonlySet<string>,
): bigint {
	const batch = sortedBatch(paymentKeys);
	if (batch.length === 0) return 0n;
	const shares = splitFeeEvenly(fee, batch.length);
	return batch.reduce((total, key, index) => (selectedPaymentKeys.has(key) ? total + shares[index] : total), 0n);
}
