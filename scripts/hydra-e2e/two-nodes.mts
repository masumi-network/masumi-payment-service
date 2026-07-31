/**
 * Two independent payment nodes, for driving the cross-organisation flow by hand.
 *
 * The end-to-end run fakes the counterparty with a stub. This does not: each
 * side is a real payment service with its own database, its own admin UI and its
 * own Hydra Host, and they only ever reach each other through the signed
 * handshake — which is the thing worth exercising, because it is what stops a
 * stranger opening a head with you.
 *
 *   HYDRA_E2E_DIR=$PWD/.hydra-two pnpm exec tsx scripts/hydra-e2e/two-nodes.mts
 *
 * Nothing is connected for you: both Hydra Hosts run and print their URLs and
 * keys, and connecting them is the first step of the flow.
 *
 * Test support only.
 */

import fs from 'node:fs';
import path from 'node:path';
import { assertPrerequisites, BLOCKFROST_PROJECT_FILE, HOSTS, LOG_DIR, REPO_ROOT, hostEnv } from './env.mjs';
import { http, runTsx, spawnNode, spawnTsx, stopAll, waitFor } from './procs.mjs';

const HOST_ENTRY = path.join(REPO_ROOT, 'packages', 'hydra-host', 'src', 'index.ts');
const ENCRYPTION_KEY = '12345678901234567890123456789012';

type Side = {
	label: string;
	port: number;
	database: string;
	adminKey: string;
	/** Which Hydra Host this operator would connect; left unconnected on purpose. */
	hostIndex: number;
	blockfrostKey: string;
};

const SIDES: Side[] = [
	{
		label: 'A',
		port: 3001,
		database: 'masumi_node_a',
		adminKey: 'node-a-admin-key-0123456789abcdef',
		hostIndex: 0,
		blockfrostKey: fs.readFileSync(BLOCKFROST_PROJECT_FILE, 'utf8').trim(),
	},
	{
		label: 'B',
		port: 3002,
		database: 'masumi_node_b',
		adminKey: 'node-b-admin-key-0123456789abcdef',
		hostIndex: 1,
		blockfrostKey: process.env.NODE_B_BLOCKFROST_KEY?.trim() ?? '',
	},
];

function serviceEnv(side: Side): NodeJS.ProcessEnv {
	return {
		...process.env,
		// Each payment node drives exactly one Host, so a single fleet-wide
		// exchange port is still one value per service — they only collide here
		// because both Hosts share a machine.
		HYDRA_HOST_EXCHANGE_PORT: String(HOSTS[side.hostIndex].exchangePort),
		DATABASE_URL: `postgresql://sandro@localhost:5432/${side.database}?schema=public`,
		ENCRYPTION_KEY,
		ADMIN_KEY: side.adminKey,
		PORT: String(side.port),
		// Nothing is throttled. These two nodes exist to be driven by hand, and
		// every one of these jobs is load-bearing for that: with CHECK_TX_INTERVAL
		// pushed to an hour the seller never observes the buyer's lock inside its
		// 300-second grace and marks a perfectly good payment "Funds or Datum
		// Invalid" — a failure invented entirely by the harness. Blockfrost calls
		// are the price of the stack behaving like the product.
		SEED_ONLY_IF_EMPTY: 'true',
	};
}

type Seeded = { sourceId: string; wallet: { id: string; address: string } };

/**
 * Seed one side with a payment source and a single hot wallet.
 *
 * No relation and no connected node: a relation names the *other* side's
 * wallet, which neither side knows until both exist, and connecting the node is
 * the step being tested.
 */
async function seed(side: Side): Promise<Seeded | null> {
	const result = await runTsx(
		`node-${side.label}-seed`,
		path.join(REPO_ROOT, 'scripts', 'hydra-e2e', 'seed-node.mts'),
		{
			...serviceEnv(side),
			SEED_BLOCKFROST_KEY: side.blockfrostKey,
			SEED_LABEL: `node-${side.label}`,
		},
	);
	const line = result.stdout
		.split('\n')
		.reverse()
		.find((entry) => entry.trim().startsWith('{'));
	if (line === undefined) {
		console.error(`  node ${side.label} seed failed: ${result.stderr.split('\n').slice(-3).join(' ')}`);
		return null;
	}
	return JSON.parse(line) as Seeded;
}

async function main(): Promise<void> {
	const problems = assertPrerequisites();
	if (problems.length > 0) {
		console.error(`cannot start: ${problems.join('; ')}`);
		process.exit(1);
	}
	const built = path.join(REPO_ROOT, 'dist', 'index.js');
	if (!fs.existsSync(built)) {
		console.error('  build first:  pnpm -C frontend run build && pnpm run build');
		process.exit(1);
	}

	fs.mkdirSync(LOG_DIR, { recursive: true });
	for (const spec of HOSTS) {
		fs.mkdirSync(spec.dataDir, { recursive: true });
		spawnTsx(`hydra-host-${spec.name}`, HOST_ENTRY, hostEnv(spec));
	}

	console.log('');
	for (const side of SIDES) {
		const seeded = await seed(side);
		spawnNode(`payment-node-${side.label}`, built, { ...serviceEnv(side), NODE_ENV: 'production' });
		await waitFor(
			`payment node ${side.label}`,
			() => http(`http://127.0.0.1:${side.port}/api/v1/health`),
			(result) => result.status === 200,
			{ timeoutMs: 120_000, intervalMs: 2_000 },
		);
		console.log(`  node ${side.label} ready  ${seeded ? `wallet ${seeded.wallet.address}` : '(seed failed)'}`);
	}

	banner();
	await new Promise(() => undefined);
}

function banner(): void {
	const lines: string[] = ['', '\u001b[1m  Two payment nodes are up\u001b[0m', ''];
	for (const side of SIDES) {
		const host = HOSTS[side.hostIndex];
		lines.push(
			`  \u001b[1mNode ${side.label}\u001b[0m`,
			`    Admin UI      http://127.0.0.1:${side.port}/admin/`,
			`    API key       ${side.adminKey}`,
			`    Its Hydra node, NOT connected — connect it yourself:`,
			`      URL         ${host.baseUrl}`,
			`      Exchange    http://127.0.0.1:${host.exchangePort}/exchange  (counterparty-facing)`,
			`      Public peer 127.0.0.1`,
			`      User key    ${host.userToken}`,
			`      Admin key   ${host.adminToken}`,
			'',
		);
	}
	lines.push(
		'  To open a head between them:',
		'    1. On each node: Hydra Heads -> Connect node, with the values above.',
		'    2. On ONE node: Invites -> Invite someone, pick a wallet, copy the code.',
		'    3. On the OTHER: Invites -> Redeem an invite, paste it, check who it is',
		'       from, then Open the head.',
		'',
		'  No wallet addresses to copy and no relation to create: the address is',
		'  inside the signed invite, and the relation is created by redeeming it.',
		'  Either side may invite \u2014 there is no initiator rule any more.',
		'',
		'  Ctrl-C stops everything.',
		'',
	);
	console.log(lines.join('\n'));
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.on(signal, () => {
		console.log('\nstopping…');
		void stopAll().finally(() => process.exit(0));
	});
}

main().catch(async (error: unknown) => {
	console.error((error as Error).message);
	await stopAll();
	process.exit(1);
});
