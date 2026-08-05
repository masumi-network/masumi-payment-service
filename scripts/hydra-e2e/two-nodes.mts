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
 * The databases and the Host state directory are all overridable, so a fresh
 * run never has to destroy an existing one:
 *
 *   NODE_A_DATABASE=masumi_node_a2 NODE_B_DATABASE=masumi_node_b2 \
 *   HYDRA_E2E_DIR=$PWD/.hydra-run2 pnpm exec tsx scripts/hydra-e2e/two-nodes.mts
 *
 * They default to the same names every time because a single local stack is the
 * common case; reaching for a second one should not mean editing this file.
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

/**
 * Which Blockfrost project each side uses.
 *
 * One key for both is the common case and what HYDRA_E2E_BLOCKFROST_KEY is for.
 * Per-side overrides exist because two nodes hammering one project is the
 * fastest way to hit a rate limit and spend an afternoon debugging a "chain is
 * behind" that is really a 429.
 */
function blockfrostKeyFor(sideVar: 'NODE_A_BLOCKFROST_KEY' | 'NODE_B_BLOCKFROST_KEY'): string {
	const perSide = process.env[sideVar]?.trim();
	if (perSide) {
		return perSide;
	}
	const shared = process.env.HYDRA_E2E_BLOCKFROST_KEY?.trim();
	if (shared) {
		return shared;
	}
	return fs.readFileSync(BLOCKFROST_PROJECT_FILE, 'utf8').trim();
}

const SIDES: Side[] = [
	{
		label: 'A',
		port: 3001,
		database: process.env.NODE_A_DATABASE ?? 'masumi_node_a',
		adminKey: 'node-a-admin-key-0123456789abcdef',
		hostIndex: 0,
		blockfrostKey: blockfrostKeyFor('NODE_A_BLOCKFROST_KEY'),
	},
	{
		label: 'B',
		port: 3002,
		database: process.env.NODE_B_DATABASE ?? 'masumi_node_b',
		adminKey: 'node-b-admin-key-0123456789abcdef',
		hostIndex: 1,
		blockfrostKey: blockfrostKeyFor('NODE_B_BLOCKFROST_KEY'),
	},
];

function serviceEnv(side: Side): NodeJS.ProcessEnv {
	return {
		...process.env,
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

type Seeded = { purchaseAddress: string; sellingAddress: string };

/**
 * Seed one side with the product's own seed script.
 *
 * `prisma/seed.ts` is what a real deployment runs, so using it means these two
 * nodes start from the same state an operator's would: the deployed V2 contract
 * and registry policy, the real admin-wallet quorum, a purchasing and a selling
 * wallet, and an admin API key. A bespoke seeder here drifted from that — it
 * invented a contract address and left policyId null, which is enough for Hydra
 * plumbing and breaks every payment, because a payment resolves its source by
 * (network, policyId).
 *
 * V2 mnemonics are generated per side rather than shared. The seed skips V2
 * seeding entirely when they are absent, and a head needs a Web3CardanoV2
 * source — so without them these nodes would come up unable to open one.
 *
 * It seeds V1 as well. That is the product's own behaviour rather than
 * something to work around: a real deployment has both, and the extra wallets
 * cost nothing here.
 */
async function seed(side: Side): Promise<Seeded | null> {
	const { MeshWallet } = await import('@meshsdk/core');
	const brew = async (): Promise<{ mnemonic: string; address: string }> => {
		const words = MeshWallet.brew() as string[];
		const wallet = new MeshWallet({ networkId: 0, key: { type: 'mnemonic', words } });
		return { mnemonic: words.join(' '), address: await wallet.getChangeAddress() };
	};

	const purchase = await brew();
	const selling = await brew();

	// Always, not just when the database is new. A database reused across
	// branches is the normal case here, and a missing column does not fail
	// loudly: every query throws P2022, the API answers 500, and the admin UI
	// concludes nothing is configured and offers the first-run wizard. That
	// looks like a seeding problem and is not one.
	const migrated = await runTsx(
		`node-${side.label}-migrate`,
		path.join(REPO_ROOT, 'node_modules', 'prisma', 'build', 'index.js'),
		{ ...serviceEnv(side) },
		['migrate', 'deploy', '--config', path.join(REPO_ROOT, 'prisma', 'prisma.config.ts')],
	);
	if (migrated.code !== 0) {
		console.error(`  node ${side.label} migrate failed: ${migrated.stderr.split('\n').slice(-4).join(' ').slice(0, 400)}`);
		return null;
	}

	const result = await runTsx(`node-${side.label}-seed`, path.join(REPO_ROOT, 'prisma', 'seed.ts'), {
		...serviceEnv(side),
		BLOCKFROST_API_KEY_PREPROD: side.blockfrostKey,
		PURCHASE_WALLET_V2_PREPROD_MNEMONIC: purchase.mnemonic,
		SELLING_WALLET_V2_PREPROD_MNEMONIC: selling.mnemonic,
		COLLECTION_WALLET_PREPROD_ADDRESS: purchase.address,
	});

	if (result.code !== 0) {
		console.error(`  node ${side.label} seed failed: ${result.stderr.split('\n').slice(-4).join(' ').slice(0, 400)}`);
		return null;
	}

	return { purchaseAddress: purchase.address, sellingAddress: selling.address };
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
		console.log(`  node ${side.label} ready  ${seeded ? `buyer ${seeded.purchaseAddress}` : '(seed failed)'}`);
		if (seeded) {
			console.log(`                  seller ${seeded.sellingAddress}`);
		}
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
		'  Either side may invite. The side that REDEEMS opens the head: the issuing',
		"  side's Init is refused, because two Inits race for the same seed inputs.",
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
