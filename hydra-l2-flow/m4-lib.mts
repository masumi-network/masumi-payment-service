/**
 * Shared helpers for the Milestone 4 preprod evidence scripts.
 * REST client for the running payment service, a deadline poller, a
 * Blockfrost reader, and a JSONL ledger appender.
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const API_BASE = process.env.M4_API_BASE ?? 'http://127.0.0.1:3011/api/v1';
export const API_KEY_FILE =
	process.env.M4_API_KEY_FILE ?? join(process.cwd(), 'hydra-l2-flow', '.native-state', 'm4-api-key.txt');
export const EVIDENCE_ROOT =
	process.env.M4_EVIDENCE_ROOT ?? join(process.cwd(), 'hydra-l2-flow', 'evidence', '2026-m4-preprod');
export const BLOCKFROST_URL = 'https://cardano-preprod.blockfrost.io/api/v0';
export const CARDANOSCAN_TX = 'https://preprod.cardanoscan.io/transaction';

export function apiKey(): string {
	return readFileSync(API_KEY_FILE, 'utf8').trim();
}

export function log(scope: string, message: string): void {
	console.log(`[${scope}] ${new Date().toISOString().slice(11, 19)} ${message}`);
}

/** Call the payment service. Throws on non-2xx with the response body in the message. */
export async function api<T>(path: string, init?: { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown }): Promise<T> {
	const res = await fetch(`${API_BASE}${path}`, {
		method: init?.method ?? 'GET',
		headers: { token: apiKey(), 'content-type': 'application/json' },
		body: init?.body === undefined ? undefined : JSON.stringify(init.body),
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
	const parsed = JSON.parse(text) as { status: string; data: T };
	return parsed.data;
}

/** Poll `fn` until it returns a non-null value or the deadline passes. */
export async function poll<T>(
	label: string,
	fn: () => Promise<T | null>,
	options: { everyMs: number; deadlineMs: number },
): Promise<T> {
	const started = Date.now();
	for (;;) {
		const value = await fn();
		if (value !== null) return value;
		if (Date.now() - started > options.deadlineMs) {
			throw new Error(`${label}: deadline of ${Math.round(options.deadlineMs / 1000)}s passed`);
		}
		await new Promise((resolve) => setTimeout(resolve, options.everyMs));
	}
}

export async function bf<T>(path: string): Promise<T | null> {
	const key = readFileSync(join(process.cwd(), 'hydra-l2-flow', 'preprod', 'blockfrost.txt'), 'utf8').trim();
	const res = await fetch(`${BLOCKFROST_URL}${path}`, { headers: { project_id: key } });
	if (res.status === 404) return null;
	if (!res.ok) throw new Error(`Blockfrost GET ${path} -> ${res.status}`);
	return (await res.json()) as T;
}

export type LedgerRow = {
	headIndex: number;
	headId: string;
	headIdentifier: string;
	kind: 'deposit' | 'withdrawal' | 'close' | 'fanout';
	txHash: string;
	/** Deposits: committed lovelace. Withdrawals: REQUESTED lovelace (what left the head). Null for close/fanout. */
	lovelace: string | null;
	/** Withdrawals only: what actually landed on L1 after the decommit paid its own L1 fee. */
	settledLovelace?: string | null;
	startedAt: string;
	doneAt: string;
};

export function appendLedger(file: string, row: LedgerRow): void {
	mkdirSync(dirname(file), { recursive: true });
	appendFileSync(file, `${JSON.stringify(row)}\n`);
}

export function readLedger(file: string): LedgerRow[] {
	try {
		return readFileSync(file, 'utf8')
			.split('\n')
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as LedgerRow);
	} catch {
		return [];
	}
}
