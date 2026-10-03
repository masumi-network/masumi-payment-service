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

import type { HydraHeadActiveWork } from '@/utils/hydra/active-work';

/** Seconds as something an operator reads, not arithmetic they perform. */
function describeDuration(seconds: number): string {
	// The column is non-nullable with a default, so this should be unreachable —
	// but every comparison below is false for NaN, which would fall through and
	// tell an operator to wait "NaN days". Naming the period vaguely is worse
	// than naming it precisely and better than naming it wrongly.
	//
	// Negative lands here too. It means different damage — arithmetic rather than
	// a missing field — but the operator's move is the same either way, so it
	// does not earn its own wording.
	if (!Number.isFinite(seconds) || seconds < 0) return 'an unknown length';
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
 * Every count is reported, but only the ones that are non-zero: a head with
 * escrows and no in-flight transactions should not be told about zero
 * transactions, which reads like a second problem.
 *
 * Takes the whole `HydraHeadActiveWork`, not loose numbers. As three positional
 * counts with a default, the reader behind the pre-close DIALOG passed only two
 * and silently described a head with an outstanding deposit as holding nothing —
 * while `hasActiveWork` still counted it, so the dialog appeared, said "This head
 * has ." and offered the acknowledgement that pre-authorises the close. The
 * server's refusal never fired, because the UI had already answered it.
 */
export function describeCloseWithActiveWork(
	contestationPeriodSeconds: bigint | number,
	work: HydraHeadActiveWork,
): string {
	const { pendingL2Transactions, activeEscrows, unrecoveredDeposits } = work;
	const held: string[] = [];
	if (activeEscrows > 0) held.push(`${countPhrase(activeEscrows, 'escrow')} still holding funds`);
	if (pendingL2Transactions > 0) held.push(`${countPhrase(pendingL2Transactions, 'transaction')} still in flight`);
	if (unrecoveredDeposits > 0) {
		held.push(`${countPhrase(unrecoveredDeposits, 'deposit')} the head has not taken`);
	}

	const wait = describeDuration(Number(contestationPeriodSeconds));

	// Deposits are called out separately because closing does NOT settle them.
	// An unabsorbed deposit is not part of the fanout: it returns only through
	// Recover, which needs a live session for this head, so a close leaves the
	// money at the deposit script with nothing left able to ask for it back.
	const it = unrecoveredDeposits === 1 ? 'it' : 'them';
	const deposits =
		unrecoveredDeposits > 0
			? `\n\nThe ${unrecoveredDeposits === 1 ? 'deposit' : 'deposits'} will NOT come back in the fanout. ` +
				`An unabsorbed deposit returns only through Recover, which needs this head's node session. ` +
				`Recover ${it} first — and if Recover is not offered yet, that is the protocol rather than a ` +
				`fault: it opens one deposit period after the absorption window closes. Leave the head enabled ` +
				`and its node running until then, or the funds stay at the deposit script with nothing able to ` +
				`ask for ${it} back.`
			: '';

	// Never rendered from an empty list: a head with nothing in it is not asked
	// about at all, and printing "This head has ." is how the missing count
	// showed up to the operator.
	if (held.length === 0) return '';

	return (
		`This head has ${held.join(' and ')}.\n\n` +
		`Closing now settles all of it on L1 instead. Nothing can be collected until the head's ` +
		`contestation period of ${wait} has elapsed, and after that each escrow is settled on chain ` +
		`separately, paying L1 fees and waiting for confirmations.\n\n` +
		`Settling inside the head first is far quicker — each one takes about a second there and costs ` +
		`no fees. Consider finishing them before closing.${deposits}`
	);
}
