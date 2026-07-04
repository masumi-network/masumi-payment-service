/**
 * Decision helper for the wallet-timeouts sweep: a HotWallet's PendingTransaction
 * has a broadcast `txHash`, but the tx is NOT visible on chain (`fetchTxInfo`
 * returned nothing). Decide whether to force-unlock the wallet or keep polling.
 *
 * The gap this closes: a registry mint/burn tx (agent register / deregister /
 * update) carries NO on-chain `invalidHereafter` TTL, so if it is dropped from
 * the mempool it never becomes provably expired — `fetchTxInfo` stays null and
 * the wallet keeps its PendingTransaction + `lockedAt` forever, wedging every
 * request that needs it.
 *
 * SAFETY — force-unlock ONLY genuine registry txs (`isRegistryTx`). It is NOT
 * safe to key this on the DB `invalidHereafterSlot` column being null: a
 * payment/purchase tx DOES carry a real on-chain `invalidHereafter` TTL even
 * though `createPendingTransaction` leaves that column null (only the V2
 * ambiguous-funding paths persist it). Force-failing such a tx while it is still
 * inside its validity window — e.g. temporarily unseen due to mempool/indexer
 * lag — would let the next batch rebuild a competing tx over the same locked
 * script UTxO and double-spend. Payment/purchase txs are recovered by the
 * request-level timeout sweeps + funding-reconciliation, never here. So the
 * caller must positively confirm the tx belongs to a registry request; the
 * `invalidHereafterSlot == null` check below is only a defensive secondary guard
 * (a registry tx should never carry a persisted slot).
 *
 * Residual risk (accepted): a registry tx that is merely delayed and lands AFTER
 * `forceUnlockAfterMs` would then have its wallet already freed — but the caller
 * does NOT re-arm the dependent request, so no double mint/burn occurs (registry
 * tx-sync still confirms by asset presence if it lands); the trade is freeing the
 * wallet vs. wedging it forever.
 */
export type UnseenPendingTxDecision = { forceUnlock: false } | { forceUnlock: true; ageMs: number };

export function classifyUnseenPendingTx(params: {
	createdAtMs: number;
	nowMs: number;
	invalidHereafterSlot: bigint | null;
	isRegistryTx: boolean;
	forceUnlockAfterMs: number;
}): UnseenPendingTxDecision {
	// Only registry mint/burn txs are safe to force-unlock (they carry no on-chain
	// TTL). Everything else — including payment/purchase txs whose DB slot is null
	// but whose broadcast tx has a real TTL — must keep polling here.
	if (!params.isRegistryTx) {
		return { forceUnlock: false };
	}
	// Defensive: a registry tx should have no persisted TTL; if one is present the
	// row is an unexpected shape — do not force-unlock.
	if (params.invalidHereafterSlot != null) {
		return { forceUnlock: false };
	}
	const ageMs = params.nowMs - params.createdAtMs;
	if (ageMs >= params.forceUnlockAfterMs) {
		return { forceUnlock: true, ageMs };
	}
	return { forceUnlock: false };
}
