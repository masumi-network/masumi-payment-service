/**
 * Self-healing for a history stream that stopped delivering confirmations.
 *
 * Every live escrow output in a head was produced by a confirmed transaction,
 * and the only source of that transaction's CBOR evidence is the history
 * websocket. If the stream stalls (a half-open socket, or a frame the replay
 * skipped) while the replay still counts as complete, the node keeps serving
 * the output, the evidence never arrives, and the live pass returns 'retry'
 * forever. Nothing errors: the head reports itself Open and Connected while
 * every L2 payment on it times out. Observed in production on 2026-10-22.
 *
 * A short gap is normal: `/snapshot/utxo` can show an output a moment before
 * its `SnapshotConfirmed` frame is processed. A gap that outlives
 * `EVIDENCE_GAP_RESTART_AFTER_MS` restarts the history socket. The fresh pass
 * replays the log, which re-earns any evidence a stalled stream withheld.
 * Restarts are spaced by `MIN_RESTART_INTERVAL_MS`, because a full replay is
 * expensive. An output earns at most one restart: if a fresh replay did not
 * fill its gap, the stream was not the cause (a committed output keeps its L1
 * producer, and a compacted history may no longer hold the frame), and more
 * restarts would only turn one unprovable output, which a peer can create,
 * into a periodic outage of the whole head.
 */
import { logger } from '@masumi/payment-core/logger';
import { HydraErrorType, HydraHeadStatus } from '@/generated/prisma/client';
import { recordHeadError } from '@/services/hydra-head-error/record';

export const EVIDENCE_GAP_RESTART_AFTER_MS = 60_000;
export const MIN_RESTART_INTERVAL_MS = 5 * 60_000;

type RestartableNode = { restartHistoryReplay(reason: string): void; status: HydraHeadStatus };

/** Per head: output reference → when its missing evidence was first seen. */
const gapFirstSeenAtMs = new Map<string, Map<string, number>>();
const lastRestartAtMs = new Map<string, number>();
/** Per head: gapped outputs a restart already tried to fill. */
const restartedForReferences = new Map<string, Set<string>>();

/**
 * Record which live outputs of a head lack evidence on this pass, and restart
 * the head's history replay when one has lacked it for too long. Outputs that
 * gained evidence, or are no longer live, are forgotten.
 *
 * Returns true when this call restarted the history replay.
 */
export function noteLiveEvidenceGaps(
	hydraHeadId: string,
	missingOutputReferences: readonly string[],
	node: RestartableNode,
	nowMs: number = Date.now(),
): boolean {
	const previous = gapFirstSeenAtMs.get(hydraHeadId);
	const current = new Map<string, number>();
	for (const reference of missingOutputReferences) {
		current.set(reference, previous?.get(reference) ?? nowMs);
	}
	const alreadyRestarted = new Set(
		[...(restartedForReferences.get(hydraHeadId) ?? [])].filter((reference) => current.has(reference)),
	);
	restartedForReferences.set(hydraHeadId, alreadyRestarted);
	if (current.size === 0) {
		gapFirstSeenAtMs.delete(hydraHeadId);
		return false;
	}
	gapFirstSeenAtMs.set(hydraHeadId, current);

	const eligibleGapStarts = [...current]
		.filter(([reference]) => !alreadyRestarted.has(reference))
		.map(([, firstSeenMs]) => firstSeenMs);
	if (eligibleGapStarts.length === 0) return false;
	const oldestGapStartMs = Math.min(...eligibleGapStarts);
	if (nowMs - oldestGapStartMs < EVIDENCE_GAP_RESTART_AFTER_MS) return false;
	const lastRestartMs = lastRestartAtMs.get(hydraHeadId);
	if (lastRestartMs !== undefined && nowMs - lastRestartMs < MIN_RESTART_INTERVAL_MS) return false;

	lastRestartAtMs.set(hydraHeadId, nowMs);
	for (const reference of current.keys()) alreadyRestarted.add(reference);
	const reason =
		`${current.size} live escrow output(s) had no confirmed-CBOR evidence for ` +
		`${Math.round((nowMs - oldestGapStartMs) / 1000)}s; restarting the history replay`;
	logger.error('[HydraReconcile] confirmed-transaction evidence gap; restarting history replay', {
		hydraHeadId,
		outputReferences: [...current.keys()],
		gapMs: nowMs - oldestGapStartMs,
	});
	void recordHeadError(hydraHeadId, node.status, HydraErrorType.CommandFailed, new Error(reason), 'HistoryEvidenceGap');
	node.restartHistoryReplay(reason);
	return true;
}

/** Drop state for heads this process no longer reconciles. */
export function retainEvidenceGapHeads(hydraHeadIds: ReadonlySet<string>): void {
	for (const hydraHeadId of [...gapFirstSeenAtMs.keys(), ...lastRestartAtMs.keys(), ...restartedForReferences.keys()]) {
		if (hydraHeadIds.has(hydraHeadId)) continue;
		gapFirstSeenAtMs.delete(hydraHeadId);
		lastRestartAtMs.delete(hydraHeadId);
		restartedForReferences.delete(hydraHeadId);
	}
}
