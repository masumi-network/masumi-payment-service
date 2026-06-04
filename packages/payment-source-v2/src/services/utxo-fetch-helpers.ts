// Single source of truth for the lookup-defer UTxO fetch pattern used by
// every V2 service. Centralizes the retry/backoff schedule so changes propagate
// consistently across submit-result, authorize-refund, collection, batch-payments etc.
//
// Mesh SDK pinning: this file lives in the V2 package but the
// `BlockfrostProvider` type is the V1-pinned one re-exported from
// `@/services/shared` — that's the type the V2 service callers all hold
// because their provider is built via `createMeshProvider(...)` which lives
// on the V1 mesh line. The runtime shape we touch here (`fetchUTxOs`) is
// stable across V1/V2 mesh versions. See
// docs/adr/0005-meshsdk-version-pinning-v1-v2.md.
import type { UTxO } from '@meshsdk/core';
import type { BlockfrostProvider } from '@/services/shared';
import { LOOKUP_DEFERRED_PREFIX } from './lookup-defer';

/**
 * Wrap `fetchUTxOs(txHash)` with progressive retries when the first call
 * returns an empty list. The most common cause is blockfrost not having
 * indexed a freshly-landed tx yet (5-30s+ lag after block confirmation on
 * preprod). The 3-step backoff (5s, 10s, 20s) covers the long tail of slow
 * indexing without burning the whole scheduler tick on a single item; if
 * STILL empty after the final attempt, we throw the transient sentinel so
 * the caller defers to the next tick instead of marking the request as
 * failed.
 */
export async function fetchUTxOsWithDeferOnEmpty(
	blockchainProvider: BlockfrostProvider,
	txHash: string,
): Promise<UTxO[]> {
	const backoffMs = [5_000, 10_000, 20_000];
	const first = await blockchainProvider.fetchUTxOs(txHash);
	if (first.length > 0) return first;
	for (const wait of backoffMs) {
		await new Promise((resolve) => setTimeout(resolve, wait));
		const next = await blockchainProvider.fetchUTxOs(txHash);
		if (next.length > 0) return next;
	}
	const totalSeconds = backoffMs.reduce((sum, ms) => sum + ms, 0) / 1000;
	throw new Error(
		`${LOOKUP_DEFERRED_PREFIX} fetchUTxOs(${txHash}) returned empty after ${backoffMs.length + 1} attempts (${totalSeconds}s total wait) — chain state not visible to blockfrost yet, deferring to tx-sync / next tick`,
	);
}
