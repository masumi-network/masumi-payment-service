/**
 * What an operator is choosing between when they close a head that is still busy.
 *
 * Closing with live escrows is allowed and always was — the refusal is a
 * prompt, not a prohibition. But the old wording led with "Cannot close", which
 * is simply untrue, and then described the consequence in protocol terms
 * ("fanned out to L1") that say nothing about what it costs.
 *
 * What it actually costs is time. Nothing can be settled until the contestation
 * period elapses, and only then does each escrow settle on L1 individually,
 * paying fees and waiting for confirmations. The same escrows settle inside the
 * head in well under a second each and cost nothing, so for a head with work
 * still in it, finishing first is almost always the cheaper path — which is the
 * thing the message should be saying.
 *
 * Pure, so the wording can be tested without a head.
 */

/** Seconds as something an operator reads, not arithmetic they perform. */
function describeDuration(seconds: number): string {
	if (seconds < 60) return `${seconds} seconds`;
	if (seconds < 3600) {
		const minutes = Math.round(seconds / 60);
		return `${minutes} minute${minutes === 1 ? '' : 's'}`;
	}
	if (seconds < 86_400) {
		const hours = Math.round((seconds / 3600) * 10) / 10;
		return `${hours} hour${hours === 1 ? '' : 's'}`;
	}
	const days = Math.round((seconds / 86_400) * 10) / 10;
	return `${days} day${days === 1 ? '' : 's'}`;
}

function countPhrase(count: number, singular: string): string {
	return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

/**
 * The prompt shown when closing a head that still holds work.
 *
 * Both counts are reported, but only the ones that are non-zero: a head with
 * escrows and no in-flight transactions should not be told about zero
 * transactions, which reads like a second problem.
 */
export function describeCloseWithActiveWork(
	contestationPeriodSeconds: bigint | number,
	pendingL2Transactions: number,
	activeEscrows: number,
): string {
	const held: string[] = [];
	if (activeEscrows > 0) held.push(`${countPhrase(activeEscrows, 'escrow')} still holding funds`);
	if (pendingL2Transactions > 0) held.push(`${countPhrase(pendingL2Transactions, 'transaction')} still in flight`);

	const wait = describeDuration(Number(contestationPeriodSeconds));

	return (
		`This head has ${held.join(' and ')}.\n\n` +
		`Closing now settles all of it on L1 instead. Nothing can be collected until the head's ` +
		`contestation period of ${wait} has elapsed, and after that each escrow is settled on chain ` +
		`separately, paying L1 fees and waiting for confirmations.\n\n` +
		`Settling inside the head first is far quicker — each one takes about a second there and costs ` +
		`no fees. Consider finishing them before closing.`
	);
}
