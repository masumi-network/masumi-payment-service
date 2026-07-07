/**
 * A `pre-submit-failed` batch outcome covers everything the build/sign step can
 * throw BEFORE broadcast: cost-model sync (Blockfrost) 5xx/timeouts, transport
 * drops, insufficient balance, serialization bugs, DB errors. Only the first
 * group is transient — a later tick can clear it on its own — so those requests
 * should revert to FundsLockingRequested and re-batch instead of parking in
 * WaitingForManualAction (which needs an operator).
 *
 * We classify CONSERVATIVELY: anything not clearly transient stays manual-action
 * so a genuinely stuck batch can't spin forever.
 */
export function isTransientPreSubmitError(error: unknown): boolean {
	const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
	return (
		message.includes('cost model') ||
		message.includes('cost-model') ||
		// 'timeout' catches network timeouts (axios "timeout of 5000ms exceeded",
		// "request timeout"), but must NOT match Prisma interactive-transaction
		// timeouts, async-mutex "Mutex timeout", or wallet-lock timeouts — those are
		// not network-transient and, per this file's conservative policy, should
		// park for an operator rather than requeue every tick forever. The 'lock'
		// exclusion is WORD-BOUNDED: a bare substring match would hit 'blockfrost'
		// (which contains "lock"), misclassifying EVERY Blockfrost timeout — the
		// single most common transient error here — as non-transient.
		(message.includes('timeout') &&
			!message.includes('transaction') &&
			!message.includes('mutex') &&
			!/\block\b/.test(message)) ||
		message.includes('etimedout') ||
		message.includes('econnreset') ||
		message.includes('enotfound') ||
		message.includes('socket hang up') ||
		message.includes('fetch failed') ||
		message.includes('network error') ||
		// Word-bounded: a bare substring match on '502'/'503'/'504' would also
		// hit those digits INSIDE amounts (e.g. 'insufficient balance: needed
		// 15034567 lovelace') and misclassify a hopeless build as transient,
		// requeuing it every tick forever.
		/\b50[234]\b/.test(message) ||
		message.includes('bad gateway') ||
		message.includes('service unavailable') ||
		message.includes('gateway timeout')
	);
}
