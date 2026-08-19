/**
 * Submit a result for every other locked escrow, from the seller's side.
 *
 * The second half of a round trip: the buyer's funds are locked in the head,
 * and this is the seller saying the work is done. Every other one on purpose,
 * so the head ends up holding both states at once — an escrow that has been
 * answered and one that has not — which is what a close and fanout then has to
 * carry, and what a single-state run would never exercise.
 *
 *   pnpm exec tsx scripts/hydra-e2e/submit-results.mts
 *   RESULT=test123 STRIDE=2 pnpm exec tsx scripts/hydra-e2e/submit-results.mts
 *
 * Test support only.
 */

import { createHash } from 'node:crypto';

const SELLER = { label: 'B', base: 'http://127.0.0.1:3002', key: 'node-b-admin-key-0123456789abcdef' };
const NETWORK = 'Preprod';
/** The result whose hash is submitted. Its content is never sent, only the hash. */
const RESULT = process.env.RESULT ?? 'test123';
/** 2 answers every other escrow; 1 answers all of them. */
const STRIDE = Math.max(1, Number(process.env.STRIDE ?? '2'));

function log(message: string): void {
	console.log(`[results] ${new Date().toISOString().slice(11, 19)} ${message}`);
}

async function api<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
	const response = await fetch(`${SELLER.base}/api/v1${path}`, {
		method,
		headers: { token: SELLER.key, 'Content-Type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await response.text();
	let parsed: { status?: string; data?: T; error?: { message?: string } };
	try {
		parsed = JSON.parse(text) as typeof parsed;
	} catch {
		throw new Error(`${method} ${path}: ${response.status} ${text.slice(0, 200)}`);
	}
	if (parsed.status !== 'success' || parsed.data === undefined) {
		throw new Error(`${method} ${path}: ${parsed.error?.message ?? text.slice(0, 200)}`);
	}
	return parsed.data;
}

type Payment = { blockchainIdentifier: string; onChainState: string | null };

/**
 * Every payment the head is currently holding funds for.
 *
 * The payment-source type has to be named: the listing defaults to
 * Web3CardanoV1 for backwards compatibility when no source filter is given, so
 * asking without it returns nothing at all on a V2-only node and looks exactly
 * like having no locked escrows.
 */
async function lockedPayments(): Promise<Payment[]> {
	const data = await api<{ Payments: Payment[] }>(
		'GET',
		`/payment/?network=${NETWORK}&limit=100&filterPaymentSourceType=Web3CardanoV2&filterOnChainState=FundsLocked`,
	);
	return data.Payments.filter((payment) => payment.onChainState === 'FundsLocked');
}

async function main(): Promise<void> {
	const submitResultHash = createHash('sha256').update(RESULT).digest('hex');
	log(`result "${RESULT}" hashes to ${submitResultHash}`);

	const locked = await lockedPayments();
	// Oldest first, so "every other one" is stable across runs rather than
	// depending on whatever order the listing happened to return.
	const ordered = [...locked].reverse();
	const chosen = ordered.filter((_payment, index) => index % STRIDE === 0);
	log(`${locked.length} locked, answering ${chosen.length} of them (every ${STRIDE})`);
	if (chosen.length === 0) return;

	// All at once, like the locks: one wallet answers them one at a time, and
	// that queue is the thing worth watching.
	const settled = await Promise.allSettled(
		chosen.map((payment) =>
			api('POST', '/payment/submit-result', {
				network: NETWORK,
				submitResultHash,
				blockchainIdentifier: payment.blockchainIdentifier,
			}),
		),
	);

	const accepted = settled.filter((result) => result.status === 'fulfilled').length;
	log(`${accepted}/${chosen.length} accepted`);
	for (const [index, result] of settled.entries()) {
		if (result.status === 'rejected') {
			log(`  ${chosen[index]?.blockchainIdentifier.slice(0, 10)}… failed: ${String(result.reason).slice(0, 160)}`);
		}
	}
	if (accepted === 0) throw new Error('no results were accepted');

	log('submission is the orchestrator’s job from here — watch for ResultSubmitted.');
}

main().then(
	() => process.exit(0),
	(error: unknown) => {
		console.error(error);
		process.exit(1);
	},
);
