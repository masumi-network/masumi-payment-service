const MAX_LISTED_HELD_WALLETS = 5;

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
