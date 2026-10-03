/**
 * Shared settlement helpers for 13-settle.mts and 15-fanout-only.mts:
 * robust Fanout submission over the hydra-node websocket, plus the small
 * log-scrape / status-poll utilities both scripts need.
 *
 * Why not HydraNode.fanout()? That method only resolves on HeadIsFinalized and
 * only rejects on CommandFailed — it hangs forever when the node answers
 * RejectedInputBecauseUnsynced (Blockfrost follower drift above
 * --unsynced-period, common on preprod). This helper gives every attempt a
 * bounded timeout, auto-retries while the node is unsynced, and treats a
 * CommandFailed carrying an Idle head state as SUCCESS (a previous attempt
 * finalized the head while we were waiting — observed 2026-07-08 on preprod).
 */
import { existsSync, readFileSync } from 'node:fs';
import type { HydraNode } from '@/lib/hydra/hydra/node';
import type { HydraHeadStatus } from '@/generated/prisma/client';

export type FanoutAttempt =
	| { outcome: 'finalized' }
	| { outcome: 'failed'; detail: string }
	| { outcome: 'unsynced'; drift: number }
	| { outcome: 'timeout' };

export function attemptFanout(wsUrl: string, timeoutMs: number): Promise<FanoutAttempt> {
	return new Promise((resolve) => {
		const ws = new WebSocket(`${wsUrl}?history=no`);
		let settled = false;
		const finish = (result: FanoutAttempt) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try {
				ws.close();
			} catch {
				/* already closing */
			}
			resolve(result);
		};
		const timer = setTimeout(() => finish({ outcome: 'timeout' }), timeoutMs);
		ws.onopen = () => ws.send(JSON.stringify({ tag: 'Fanout' }));
		ws.onerror = () => finish({ outcome: 'timeout' });
		ws.onmessage = (event) => {
			let msg: Record<string, unknown>;
			try {
				msg = JSON.parse(String(event.data));
			} catch {
				return;
			}
			if (msg.tag === 'HeadIsFinalized') {
				finish({ outcome: 'finalized' });
			} else if (msg.tag === 'CommandFailed') {
				// Fanout on an already-Idle head: an earlier attempt (or the node's
				// own re-post) finalized it while we waited — success, not failure.
				const state = msg.state as { tag?: string } | undefined;
				if (state?.tag === 'Idle') {
					finish({ outcome: 'finalized' });
				} else {
					finish({ outcome: 'failed', detail: JSON.stringify(msg) });
				}
			} else if (msg.tag === 'RejectedInputBecauseUnsynced') {
				finish({ outcome: 'unsynced', drift: Number(msg.drift ?? -1) });
			}
			// ignore Tick/Greetings/other broadcast traffic while waiting
		};
	});
}

export interface FanoutRetryOptions {
	/** Per-attempt wait for a definitive WS answer (default 120s — a fanout needs a block + follower observation). */
	attemptTimeoutMs?: number;
	/** Pause between attempts while the node reports unsynced (default 20s). */
	retryDelayMs?: number;
	/** Overall budget before giving up (default 15 min). */
	maxTotalWaitMs?: number;
	log?: (message: string) => void;
}

/** Retry attemptFanout until finalized/failed or the total budget is spent. */
export async function fanoutWithRetry(wsUrl: string, options: FanoutRetryOptions = {}): Promise<FanoutAttempt> {
	const attemptTimeoutMs = options.attemptTimeoutMs ?? 120000;
	const retryDelayMs = options.retryDelayMs ?? 20000;
	const maxTotalWaitMs = options.maxTotalWaitMs ?? 15 * 60 * 1000;
	const log = options.log ?? (() => undefined);

	const start = Date.now();
	let result: FanoutAttempt = { outcome: 'timeout' };
	while (Date.now() - start < maxTotalWaitMs) {
		result = await attemptFanout(wsUrl, attemptTimeoutMs);
		if (result.outcome === 'finalized' || result.outcome === 'failed') return result;
		if (result.outcome === 'unsynced') {
			log(`node still unsynced (drift ${result.drift}s) — retrying in ${retryDelayMs / 1000}s…`);
		} else {
			log(`no definitive response within ${attemptTimeoutMs / 1000}s — retrying…`);
		}
		await new Promise((r) => setTimeout(r, retryDelayMs));
	}
	return result;
}

/** The hydra-node API URL, as a websocket URL. */
export function toWsUrl(httpUrl: string): string {
	return httpUrl.replace('http://', 'ws://').replace('https://', 'wss://');
}

// Best-effort: pull the most recent L1 tx id the node posted for a given tag
// (e.g. CloseTx / FanoutTx) out of the native node log. Returns '' if unknown.
export function lastTxIdForTag(nativeLogPath: string, tag: string): string {
	if (!nativeLogPath || !existsSync(nativeLogPath)) return '';
	const lines = readFileSync(nativeLogPath, 'utf-8').split('\n');
	for (let i = lines.length - 1; i >= 0; i--) {
		if (lines[i].includes(tag)) {
			const m = lines[i].match(/"transactionId":"([0-9a-f]{64})"/) ?? lines[i].match(/"txId":"([0-9a-f]{64})"/);
			if (m) return m[1];
		}
	}
	return '';
}

/** Poll node.status until it reaches `target`; false when timeoutMs elapses first. */
export async function waitForStatus(node: HydraNode, target: HydraHeadStatus, timeoutMs: number): Promise<boolean> {
	const start = Date.now();
	while (node.status !== target) {
		if (Date.now() - start > timeoutMs) return false;
		await new Promise((r) => setTimeout(r, 500));
	}
	return true;
}
