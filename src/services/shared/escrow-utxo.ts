import { IFetcher, UTxO } from '@meshsdk/core';
import { logger } from '@masumi/payment-core/logger';

export const ESCROW_UTXO_SPENT_MESSAGE =
	'Escrow UTxO is already spent on chain. The recorded transaction state is stale; wait for tx-sync to observe the new on-chain state before retrying.';

/**
 * How long a fetched contract-address UTxO set may be reused.
 *
 * The six escrow services each tick independently against the SAME contract
 * address, and each processes its requests inside `advancedRetryAll`. Without
 * memoisation every request — and every retry of every request — paginates the
 * entire address, which on a busy payment source is several sequential
 * Blockfrost calls each. One fetch per address per short window collapses that
 * back to roughly one.
 *
 * Staleness is safe in one direction only, which is the direction that matters:
 * a stale set can make a just-spent UTxO still look unspent (we then build and
 * fail exactly as we did before this guard existed — no worse), but it can
 * never invent a spend. Kept short so the guard stays useful.
 */
const ADDRESS_UTXO_CACHE_TTL_MS = 15_000;

type CachedAddressUtxos = { utxos: UTxO[]; fetchedAtMs: number };

const addressUtxoCache = new Map<string, CachedAddressUtxos>();

/** Test seam — the cache is module state and would otherwise leak across cases. */
export function clearEscrowUtxoCache(): void {
	addressUtxoCache.clear();
}

async function fetchLiveAddressUtxos(
	blockchainProvider: IFetcher,
	smartContractAddress: string,
	nowMs: number,
): Promise<UTxO[]> {
	const cached = addressUtxoCache.get(smartContractAddress);
	if (cached != null && nowMs - cached.fetchedAtMs < ADDRESS_UTXO_CACHE_TTL_MS) {
		return cached.utxos;
	}

	const utxos = await blockchainProvider.fetchAddressUTxOs(smartContractAddress);
	// Only cache a positive result. An empty set is precisely the ambiguous
	// case (see assertEscrowUtxoUnspent) and must not be pinned for 15s.
	if (utxos.length > 0) {
		addressUtxoCache.set(smartContractAddress, { utxos, fetchedAtMs: nowMs });
	}
	return utxos;
}

/**
 * Confirms the escrow UTxO the action is about to spend is still unspent.
 *
 * `BlockfrostProvider.fetchUTxOs(txHash)` resolves `GET /txs/{hash}/utxos`,
 * which returns every OUTPUT of that transaction whether or not it has since
 * been consumed. Matching the escrow datum against that list therefore
 * succeeds even for an output another transaction already spent, and the
 * service happily builds a transaction spending it.
 *
 * The ledger only rejects it at evaluation time, and the rejection is opaque:
 * Ogmios cannot resolve the input, so it cannot see that the input is
 * script-locked, and reports the (correctly indexed) spend redeemer as
 * `extraRedeemers` instead of an unknown-input error. Checking the address's
 * live UTxO set turns that into a diagnosable failure at the point of cause.
 *
 * IMPORTANT — this guard only ever fires on a POSITIVE signal. Mesh's
 * `BlockfrostProvider.fetchAddressUTxOs` ends in `catch { return [] }`, so a
 * 429, a transient 5xx, a timeout and a genuinely empty address are all
 * indistinguishable at this layer. Treating an empty set as proof of spending
 * would convert every Blockfrost hiccup into a request parked in
 * WaitingForManualAction — far worse than the failure this guard exists to
 * diagnose. So we conclude "spent" ONLY when the address returns a non-empty
 * set that does not contain our UTxO. An escrow contract address serving live
 * requests is never legitimately empty.
 *
 * V1 has no deferred-lookup mechanism, so a positive spent result parks the
 * request in WaitingForManualAction. V2's escrow services have no equivalent
 * guard yet; when added there it should throw `LookupDeferredError` instead,
 * letting tx-sync reconcile the stale state.
 */
export async function assertEscrowUtxoUnspent(
	blockchainProvider: IFetcher,
	smartContractAddress: string,
	utxo: UTxO,
	nowMs: number = Date.now(),
): Promise<void> {
	const liveUtxos = await fetchLiveAddressUtxos(blockchainProvider, smartContractAddress, nowMs);

	if (liveUtxos.length === 0) {
		// Inconclusive, not negative. Proceed and let the build/submit path
		// surface the real error rather than asserting a spend we cannot see.
		logger.warn('assertEscrowUtxoUnspent: contract address returned no UTxOs; skipping the spent check', {
			smartContractAddress,
			txHash: utxo.input.txHash,
			outputIndex: utxo.input.outputIndex,
		});
		return;
	}

	const isUnspent = liveUtxos.some(
		(liveUtxo) => liveUtxo.input.txHash === utxo.input.txHash && liveUtxo.input.outputIndex === utxo.input.outputIndex,
	);
	if (!isUnspent) {
		throw new Error(`${ESCROW_UTXO_SPENT_MESSAGE} (${utxo.input.txHash}#${utxo.input.outputIndex})`);
	}
}
