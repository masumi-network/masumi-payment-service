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
 * Distinguish a PERMANENT Blockfrost failure (revoked/invalid project key,
 * exhausted quota, missing auth) from the transient 404/5xx we retry on. These
 * never resolve by retrying, so a defer loop would re-park the same item every
 * scheduler tick forever. We check both the numeric status (axios-style
 * `response.status`, or Blockfrost's `status_code`) and the auth/quota phrases
 * Blockfrost puts in the error body, keeping the message match narrow to avoid
 * false positives against a transient error that merely mentions a number.
 */
function isPermanentBlockfrostError(error: unknown): boolean {
	if (typeof error === 'object' && error != null) {
		const e = error as {
			status?: number;
			status_code?: number;
			response?: { status?: number };
		};
		const status = e.response?.status ?? e.status ?? e.status_code;
		if (status === 401 || status === 402 || status === 403) return true;
	}
	const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
	// No bare 'exceeded' match: transient burst rate-limiting (429, "rate limit
	// exceeded") also says "exceeded" and MUST keep retrying/deferring — only
	// the specific auth/daily-quota phrases below are permanent.
	return (
		message.includes('project token') ||
		message.includes('invalid project') ||
		message.includes('usage limit') ||
		message.includes('daily request limit')
	);
}

/**
 * Wrap `fetchUTxOs(txHash)` with progressive retries when the tx is not yet
 * visible to blockfrost. The most common cause is blockfrost not having
 * indexed a freshly-landed tx yet (5-30s+ lag after block confirmation on
 * preprod).
 *
 * IMPORTANT: mesh's `BlockfrostProvider.fetchUTxOs` does NOT return an empty
 * list for an unindexed tx — it THROWS a 404-derived error (the endpoint is
 * `GET txs/{hash}/utxos`, which 404s until the tx is indexed). A transient 5xx
 * throws too. So we must treat a THROW (not just an empty array) as
 * "not visible yet" and keep retrying; otherwise the raw error escapes without
 * the defer sentinel and the caller parks the request in WaitingForManualAction.
 *
 * The 3-step backoff (5s, 10s, 20s) covers the long tail of slow indexing
 * without burning the whole scheduler tick on a single item; if the tx is
 * STILL not visible after the final attempt, we throw the transient sentinel so
 * the caller defers to the next tick instead of marking the request as failed.
 */
export async function fetchUTxOsWithDeferOnEmpty(
	blockchainProvider: BlockfrostProvider,
	txHash: string,
): Promise<UTxO[]> {
	const backoffMs = [0, 5_000, 10_000, 20_000];
	let lastError: unknown;
	for (const wait of backoffMs) {
		if (wait > 0) {
			await new Promise((resolve) => setTimeout(resolve, wait));
		}
		try {
			const utxos = await blockchainProvider.fetchUTxOs(txHash);
			if (utxos.length > 0) return utxos;
			lastError = undefined;
		} catch (error) {
			// A permanent auth/quota failure (revoked key, exhausted quota) will
			// never clear by retrying; surface it WITHOUT the defer sentinel so the
			// caller parks the request in WaitingForManualAction for an operator
			// instead of looping every tick.
			if (isPermanentBlockfrostError(error)) {
				throw error instanceof Error
					? error
					: new Error(`fetchUTxOs(${txHash}) failed with a permanent Blockfrost error`);
			}
			// 404 (tx not indexed yet) or a transient 5xx — retry, don't surface
			// the raw error to the caller (which would fail the request).
			lastError = error;
		}
	}
	const totalSeconds = backoffMs.reduce((sum, ms) => sum + ms, 0) / 1000;
	const detail = lastError instanceof Error ? `: ${lastError.message}` : '';
	throw new Error(
		`${LOOKUP_DEFERRED_PREFIX} fetchUTxOs(${txHash}) not visible to blockfrost after ${backoffMs.length} attempts (${totalSeconds}s total wait)${detail} — chain state not visible to blockfrost yet, deferring to tx-sync / next tick`,
	);
}
