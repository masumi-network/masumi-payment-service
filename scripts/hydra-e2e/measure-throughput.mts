/**
 * How fast escrows actually reach the head, measured from the outside.
 *
 * Counts state transitions by polling the buyer's own listing rather than
 * reading the database, so what it reports is what the product reports. The
 * number worth having is not "50 locks in N seconds" — the first lock cannot
 * start until the orchestrator's next cycle, and that idle head start would be
 * folded into the rate. It measures the ACTIVE window instead: first lock to
 * last lock, which is the throughput of the queue itself.
 *
 *   TARGET=50 pnpm exec tsx scripts/hydra-e2e/measure-throughput.mts
 *   TARGET=25 STATE=ResultSubmitted SIDE=seller pnpm exec tsx scripts/hydra-e2e/measure-throughput.mts
 *
 * Test support only.
 */

const SIDES = {
	buyer: {
		label: 'A',
		base: 'http://127.0.0.1:3001',
		key: 'node-a-admin-key-0123456789abcdef',
		path: '/purchase/',
		collection: 'Purchases',
	},
	seller: {
		label: 'B',
		base: 'http://127.0.0.1:3002',
		key: 'node-b-admin-key-0123456789abcdef',
		path: '/payment/',
		collection: 'Payments',
	},
} as const;

const SIDE = SIDES[(process.env.SIDE ?? 'buyer') as keyof typeof SIDES];
const NETWORK = 'Preprod';
/** How many are expected to arrive; polling stops early once they all have. */
const TARGET = Number(process.env.TARGET ?? '50');
/** The on-chain state being waited for. */
const STATE = process.env.STATE ?? 'FundsLocked';
const POLL_MS = Number(process.env.POLL_MS ?? '2000');
/** Give up if nothing new arrives for this long — a stall is a result too. */
const STALL_MS = Number(process.env.STALL_MS ?? '180000');

function log(message: string): void {
	console.log(`[tps] ${new Date().toISOString().slice(11, 19)} ${message}`);
}

async function countInState(): Promise<number> {
	const url =
		`${SIDE.base}/api/v1${SIDE.path}?network=${NETWORK}&limit=100` +
		`&filterPaymentSourceType=Web3CardanoV2&filterOnChainState=${STATE}`;
	const response = await fetch(url, { headers: { token: SIDE.key } });
	const parsed = (await response.json()) as {
		status?: string;
		data?: Record<string, Array<{ onChainState: string | null }>>;
		error?: { message?: string };
	};
	if (parsed.status !== 'success' || !parsed.data) {
		throw new Error(`listing failed: ${parsed.error?.message ?? 'unknown'}`);
	}
	const rows = parsed.data[SIDE.collection] ?? [];
	return rows.filter((row) => row.onChainState === STATE).length;
}

async function main(): Promise<void> {
	const baseline = await countInState();
	log(
		`watching ${SIDE.collection} on ${SIDE.label} for ${STATE}; ${baseline} already there, waiting for ${TARGET} more`,
	);

	const startedAt = Date.now();
	/** Wall-clock of each new arrival, so the rate can exclude the head start. */
	const arrivals: number[] = [];
	let lastChangeAt = startedAt;
	let seen = 0;

	for (;;) {
		await new Promise((resolve) => setTimeout(resolve, POLL_MS));
		const now = Date.now();
		const current = (await countInState()) - baseline;
		if (current > seen) {
			// One timestamp per arrival. Several can land inside one poll interval,
			// and collapsing them to a single point would under-report the rate.
			for (let i = seen; i < current; i++) arrivals.push(now);
			log(`${current}/${TARGET} ${STATE} (+${current - seen}) at ${((now - startedAt) / 1000).toFixed(1)}s`);
			seen = current;
			lastChangeAt = now;
		}
		if (seen >= TARGET) break;
		if (now - lastChangeAt > STALL_MS) {
			log(`no change for ${(STALL_MS / 1000).toFixed(0)}s — stopping at ${seen}/${TARGET}`);
			break;
		}
	}

	const first = arrivals[0];
	const last = arrivals[arrivals.length - 1];
	if (first === undefined || last === undefined) {
		log('nothing arrived — no rate to report');
		return;
	}

	const startupSeconds = (first - startedAt) / 1000;
	const activeSeconds = (last - first) / 1000;
	const totalSeconds = (last - startedAt) / 1000;

	log('---');
	log(`${seen} reached ${STATE}`);
	log(`  time to first:   ${startupSeconds.toFixed(1)}s  (orchestrator cycle, not throughput)`);
	log(`  active window:   ${activeSeconds.toFixed(1)}s  (first arrival to last)`);
	log(`  total elapsed:   ${totalSeconds.toFixed(1)}s`);
	if (activeSeconds > 0) {
		// n-1 gaps between n arrivals: the first one costs no queue time.
		log(`  throughput:      ${((seen - 1) / activeSeconds).toFixed(2)}/s over the active window`);
		log(`  per escrow:      ${((activeSeconds / (seen - 1)) * 1000).toFixed(0)}ms`);
	}
	if (totalSeconds > 0) {
		log(`  end to end:      ${(seen / totalSeconds).toFixed(2)}/s including the wait for the first`);
	}
}

main().then(
	() => process.exit(0),
	(error: unknown) => {
		console.error(error);
		process.exit(1);
	},
);
