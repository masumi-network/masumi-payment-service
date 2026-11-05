const MAX_LISTED_HELD_WALLETS = 5;

/** Opens the note a lock pass leaves when no free wallet could pay a request. */
export const FUNDS_FIT_MISS_NOTE_PREFIX = 'Not enough funds in the free purchasing wallets';

/**
 * The note for a request that no free purchasing wallet could pay this tick.
 *
 * Written onto the pending lock action while the request keeps retrying. The
 * purchase API and webhook bodies carry it at once; the admin UI shows it
 * once the timeout sets an errorType. The timeout reads it to tell a funds
 * shortage from an unexplained silence.
 */
export function buildFundsFitMissNote(params: {
	unit: string;
	requiredAmount: string;
	availableAmount: string;
	freeWalletCount: number;
	eligibleWalletCount: number;
}): string {
	const unit = params.unit === '' || params.unit.toLowerCase() === 'lovelace' ? 'lovelace' : params.unit;
	return `${FUNDS_FIT_MISS_NOTE_PREFIX}: ${unit} needs ${params.requiredAmount}, the closest free wallet has ${params.availableAmount} (${params.freeWalletCount} of ${params.eligibleWalletCount} eligible wallets free).`;
}

/** Whether the request's last lock attempt failed on funds, per the note it left. */
export function isFundsFitMissNote(note: string | null | undefined): boolean {
	return typeof note === 'string' && note.startsWith(FUNDS_FIT_MISS_NOTE_PREFIX);
}

/**
 * The operator-facing note for a purchase that timed out before any lock.
 *
 * The bare "payByTime passed" note hid why nothing locked. An earlier error on
 * the request is kept, and the payment source's purchasing wallets still held
 * by a pending transaction are named: a held wallet silently stops both the L2
 * and the L1 lock pass. They are source-wide, not necessarily this request's.
 */
export function buildPurchaseTimeoutNote(params: {
	payByTime: bigint | null;
	graceSeconds: number;
	previousErrorNote: string | null;
	heldPurchasingWallets: ReadonlyArray<{ id: string; lockedAt: Date | null; pendingTransactionId: string | null }>;
}): string {
	const { payByTime, graceSeconds, previousErrorNote, heldPurchasingWallets } = params;
	let note = `Purchase request payByTime (${payByTime?.toString() ?? 'unset'}) passed without on-chain lock; no FundsLocked tx observed within ${graceSeconds}s grace.`;
	if (heldPurchasingWallets.length > 0) {
		const held = heldPurchasingWallets
			.slice(0, MAX_LISTED_HELD_WALLETS)
			.map(
				(wallet) =>
					`${wallet.id} (pending tx ${wallet.pendingTransactionId ?? 'none'} since ${wallet.lockedAt?.toISOString() ?? 'unknown'})`,
			)
			.join(', ');
		const more =
			heldPurchasingWallets.length > MAX_LISTED_HELD_WALLETS
				? ` and ${heldPurchasingWallets.length - MAX_LISTED_HELD_WALLETS} more`
				: '';
		note += ` Purchasing wallets of this payment source held at timeout: ${held}${more}.`;
	}
	if (previousErrorNote) note += ` Previous error: ${previousErrorNote}`;
	return note;
}
