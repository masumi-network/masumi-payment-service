import { Network } from '@/generated/prisma/client';
import { getBlockfrostInstance } from '@/utils/blockfrost';

/**
 * Whether a transaction is on chain.
 *
 * `not-found` and `transient-error` MUST NOT be conflated. Callers act on them
 * in opposite directions: not-found (past a deadline) means the tx will never
 * land, so state can be reverted and the inputs re-spent; transient means the
 * indexer is unreachable and we know nothing. Treating a 5xx as not-found
 * re-sends a transaction that already landed; treating a 404 as transient
 * strands the row forever.
 */
export type ChainTxLookupResult = 'found' | 'not-found' | 'transient-error';

export type ConfirmedChainTxLookupResult =
	| 'not-found'
	| 'pending'
	| 'confirmed-valid'
	| 'confirmed-invalid'
	| 'transient-error';

const DEFAULT_CHAIN_OBSERVER_TIMEOUT_MS = 15_000;

/**
 * Read the HTTP status of a failed chain lookup.
 *
 * Deliberately structured rather than a regex over the error text. Two live
 * traps make text matching wrong here:
 *
 *   - `BlockfrostServerError.message` is the API's message field verbatim. A
 *     real 404 reads "The requested component has not been found." — it
 *     contains neither "404" nor a `not.?found` match ("not BEEN found"), so a
 *     `/404|not.?found/i` test silently classifies every genuine 404 as an
 *     outage. The status lives on `.status_code`.
 *   - Mesh's `parseHttpError` THROWS A STRING of
 *     `JSON.stringify({data, headers, status})`. Regex-matching it searches the
 *     response headers, where `content-length: 404` or a hex `cf-ray` fragment
 *     turns an unrelated 5xx into a false not-found.
 *
 * So: read `status_code` (blockfrost-js), else `status`/`response.status`
 * (axios-shaped), else give up and report transient — the safe direction.
 */
export function getChainErrorStatus(error: unknown): number | undefined {
	if (typeof error !== 'object' || error === null) return undefined;

	const candidate = error as {
		status_code?: unknown;
		status?: unknown;
		response?: { status?: unknown };
	};

	if (typeof candidate.status_code === 'number') return candidate.status_code;
	if (typeof candidate.status === 'number') return candidate.status;
	if (typeof candidate.response?.status === 'number') return candidate.response.status;

	return undefined;
}

/**
 * Look a transaction up on chain via Blockfrost.
 *
 * Uses `getBlockfrostInstance` rather than a Mesh provider because blockfrost-js
 * raises `BlockfrostServerError` with a structured `status_code`, whereas Mesh
 * throws an opaque stringified blob (see above). An unrecognised failure is
 * reported `transient-error`: the caller then waits instead of acting on a
 * guess, which is the only safe default when funds are involved.
 */
export async function lookupChainTx(params: {
	network: Network;
	rpcProviderApiKey: string;
	txHash: string;
}): Promise<ChainTxLookupResult> {
	const blockfrost = getBlockfrostInstance(params.network, params.rpcProviderApiKey);

	try {
		await blockfrost.txs(params.txHash);
		return 'found';
	} catch (error) {
		return getChainErrorStatus(error) === 404 ? 'not-found' : 'transient-error';
	}
}

/**
 * Verify exact, phase-aware transaction finality with an independent observer.
 * A successful `txs` lookup alone is not durable evidence: the indexed block
 * can still disappear in a shallow rollback. A failure after the transaction
 * was found is therefore always transient, including a block lookup 404.
 */
export async function lookupConfirmedChainTx(params: {
	network: Network;
	rpcProviderApiKey: string;
	txHash: string;
	requiredConfirmations: number;
	observerTimeoutMs?: number;
}): Promise<ConfirmedChainTxLookupResult> {
	const observerTimeoutMs = params.observerTimeoutMs ?? DEFAULT_CHAIN_OBSERVER_TIMEOUT_MS;
	if (
		!/^[0-9a-f]{64}$/.test(params.txHash) ||
		!Number.isSafeInteger(params.requiredConfirmations) ||
		params.requiredConfirmations < 0 ||
		!Number.isSafeInteger(observerTimeoutMs) ||
		observerTimeoutMs <= 0 ||
		observerTimeoutMs > 60_000
	) {
		return 'transient-error';
	}

	const blockfrost = getBlockfrostInstance(params.network, params.rpcProviderApiKey);
	return await withChainObserverTimeout(
		(async (): Promise<ConfirmedChainTxLookupResult> => {
			let details: Awaited<ReturnType<typeof blockfrost.txs>>;
			try {
				details = await blockfrost.txs(params.txHash);
			} catch (error) {
				return getChainErrorStatus(error) === 404 ? 'not-found' : 'transient-error';
			}

			if (
				typeof details.hash !== 'string' ||
				details.hash !== params.txHash ||
				typeof details.valid_contract !== 'boolean'
			) {
				return 'transient-error';
			}

			if (params.requiredConfirmations > 0) {
				if (typeof details.block !== 'string' || details.block.length === 0) return 'transient-error';
				try {
					const block = await blockfrost.blocks(details.block);
					if (
						typeof block.confirmations !== 'number' ||
						!Number.isSafeInteger(block.confirmations) ||
						block.confirmations < 0
					) {
						return 'transient-error';
					}
					if (block.confirmations < params.requiredConfirmations) return 'pending';
				} catch {
					return 'transient-error';
				}
			}

			return details.valid_contract ? 'confirmed-valid' : 'confirmed-invalid';
		})(),
		observerTimeoutMs,
	);
}

async function withChainObserverTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T | 'transient-error'> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<'transient-error'>((resolve) => {
				timeout = setTimeout(() => resolve('transient-error'), timeoutMs);
				timeout.unref?.();
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}
