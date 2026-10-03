/**
 * Bring up a Hydra stack and leave it running, for driving by hand.
 *
 * Everything the end-to-end run exercises, but persistent and seeded so the
 * admin UI has something to act on: two Hydra Hosts, a payment service, a
 * counterparty stub standing in for the other operator, and the admin UI.
 *
 *   HYDRA_E2E_DIR=.hydra-demo pnpm exec tsx scripts/hydra-e2e/demo.mts
 *
 * Runs until interrupted. Point it at its own run directory and database so it
 * never fights `run.mts` over ports or registry files. The admin UI is started
 * separately (`pnpm -C frontend dev --port 3020`), because it is a Next server
 * rather than a TypeScript entrypoint.
 *
 * Test support only.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
	assertPrerequisites,
	BLOCKFROST_PROJECT_FILE,
	HOSTS,
	LOG_DIR,
	REPO_ROOT,
	hostEnv,
	type HostSpec,
} from './env.mjs';
import { http, runTsx, sleep, spawnNode, spawnTsx, stopAll, waitFor } from './procs.mjs';

const HOST_ENTRY = path.join(REPO_ROOT, 'packages', 'hydra-host', 'src', 'index.ts');
const SERVICE_PORT = 3001;
const STUB_PORT = 3011;
const SERVICE_URL = `http://127.0.0.1:${SERVICE_PORT}`;
const ADMIN_KEY = 'hydra-demo-admin-key-0123456789abcdef';
const DATABASE_URL =
	process.env.HYDRA_DEMO_DATABASE_URL ?? 'postgresql://sandro@localhost:5432/masumi_hydra_demo?schema=public';
const ENCRYPTION_KEY = '12345678901234567890123456789012';

type Relation = { relationId: string; weInitiate: boolean; localAddress: string; remoteMnemonic: string };
type Fixture = { sourceId: string; hostId: string; outbound: Relation; inbound: Relation | null };

function serviceEnv(): NodeJS.ProcessEnv {
	return {
		...process.env,
		DATABASE_URL,
		ENCRYPTION_KEY,
		ADMIN_KEY,
		PORT: String(SERVICE_PORT),
		// Background jobs would hammer Blockfrost with the fixture key and add
		// nothing here; push them past the life of the session.
		BATCH_PAYMENT_INTERVAL: '3600',
		CHECK_TX_INTERVAL: '3600',
		CHECK_COLLECTION_INTERVAL: '3600',
		CHECK_COLLECT_REFUND_INTERVAL: '3600',
		CHECK_SET_REFUND_INTERVAL: '3600',
		CHECK_UNSET_REFUND_INTERVAL: '3600',
		CHECK_AUTHORIZE_REFUND_INTERVAL: '3600',
		CHECK_SUBMIT_RESULT_INTERVAL: '3600',
		CHECK_WALLET_TRANSACTION_HASH_INTERVAL: '3600',
		REGISTER_AGENT_INTERVAL: '3600',
		DEREGISTER_AGENT_INTERVAL: '3600',
		SEED_ONLY_IF_EMPTY: 'true',
	};
}

/**
 * Put the built admin bundle where the server looks for it.
 *
 * The server resolves `frontend/dist` relative to its own directory, which is
 * `dist/` once built — the layout the container image produces. A symlink gives
 * the same result from a source checkout without copying the bundle.
 */
function linkAdminBundle(): void {
	const target = path.join(REPO_ROOT, 'dist', 'frontend');
	fs.rmSync(target, { recursive: true, force: true });
	fs.mkdirSync(target, { recursive: true });
	fs.symlinkSync(path.join(REPO_ROOT, 'frontend', 'dist'), path.join(target, 'dist'), 'dir');
}

function banner(hosts: HostSpec[], fixture: Fixture | null): void {
	const lines = [
		'',
		'[1m  Hydra demo stack is up[0m',
		'',
		`  Admin UI          ${SERVICE_URL}/admin/hydra-heads`,
		`  Payment API       ${SERVICE_URL}/api/v1`,
		`  Admin API key     ${ADMIN_KEY}`,
		'',
		'  Connected node (already registered, and the values to re-add it):',
		`    URL             ${hosts[0].baseUrl}`,
		`    Public peer     127.0.0.1`,
		`    User key        ${hosts[0].userToken}`,
		`    Admin key       ${hosts[0].adminToken}`,
		'',
		'  A second node you can connect by hand, to try the Connect node form:',
		`    URL             ${hosts[1].baseUrl}`,
		`    Public peer     127.0.0.1`,
		`    User key        ${hosts[1].userToken}`,
		`    Admin key       ${hosts[1].adminToken}`,
		'',
	];
	if (fixture) {
		lines.push(
			'  Seeded relation, ready to propose a head on:',
			`    Relation        ${fixture.outbound.relationId}`,
			`    Counterparty    http://127.0.0.1:${STUB_PORT} (stub, answering as the other operator)`,
			'',
		);
	}
	lines.push('  Press Ctrl-C to stop everything.', '');
	console.log(lines.join('\n'));
}

async function main(): Promise<void> {
	const problems = assertPrerequisites();
	if (problems.length > 0) {
		console.error(`cannot start: ${problems.join('; ')}`);
		process.exit(1);
	}

	// Created rather than wiped: a demo stack is meant to be restartable, so it
	// keeps whatever nodes and heads the last session left behind.
	fs.mkdirSync(LOG_DIR, { recursive: true });
	for (const spec of HOSTS) {
		fs.mkdirSync(spec.dataDir, { recursive: true });
		spawnTsx(`demo-${spec.name}`, HOST_ENTRY, hostEnv(spec));
	}
	for (const spec of HOSTS) {
		await waitFor(
			`${spec.name} control plane`,
			() => http(`${spec.baseUrl}/v1/capabilities`, { token: spec.adminToken }),
			(result) => result.status === 200,
			{ timeoutMs: 90_000 },
		);
		console.log(`  ${spec.name} ready at ${spec.baseUrl}`);
	}

	const seeded = await runTsx('demo-fixture', path.join(REPO_ROOT, 'scripts', 'hydra-e2e', 'fixture.mts'), {
		...serviceEnv(),
		FIXTURE_HOST_URL: HOSTS[0].baseUrl,
		FIXTURE_HOST_ADMIN_TOKEN: HOSTS[0].adminToken,
		FIXTURE_HOST_USER_TOKEN: HOSTS[0].userToken,
		FIXTURE_COUNTERPARTY_URL: `http://127.0.0.1:${STUB_PORT}`,
		// One relation only. The acceptor-side relation exists for the assertions,
		// which need a counterparty to send the offer — by hand it is just a second
		// wallet nobody can use.
		FIXTURE_RELATIONS: 'outbound',
		// Real key: the admin UI fetches wallet balances on load, and a placeholder
		// makes every page open behind an error overlay.
		FIXTURE_BLOCKFROST_KEY: fs.readFileSync(BLOCKFROST_PROJECT_FILE, 'utf8').trim(),
	});
	const line = seeded.stdout
		.split('\n')
		.reverse()
		.find((entry) => entry.trim().startsWith('{'));
	const fixture = line === undefined ? null : (JSON.parse(line) as Fixture);
	if (fixture === null) {
		console.error(`  fixture failed: ${seeded.stderr.split('\n').slice(-3).join(' ')}`);
	} else {
		console.log(`  seeded payment source ${fixture.sourceId}`);
	}

	// The built server, not the sources: in production the payment service also
	// serves the admin UI as static files from the same origin, so the UI and the
	// API share one port and the browser needs no cross-origin configuration.
	// That only happens for a real build, so this insists on one.
	const built = path.join(REPO_ROOT, 'dist', 'index.js');
	if (!fs.existsSync(built) || !fs.existsSync(path.join(REPO_ROOT, 'frontend', 'dist', 'index.html'))) {
		console.error('  build first:  pnpm -C frontend run build && pnpm run build');
		await stopAll();
		process.exit(1);
	}
	linkAdminBundle();
	spawnNode('demo-payment-service', built, { ...serviceEnv(), NODE_ENV: 'production' });
	await waitFor(
		'the payment service',
		() => http(`${SERVICE_URL}/api/v1/health`),
		(result) => result.status === 200,
		{ timeoutMs: 120_000, intervalMs: 2_000 },
	);
	console.log(`  payment service ready at ${SERVICE_URL}`);

	if (fixture) {
		spawnTsx('demo-counterparty-stub', path.join(REPO_ROOT, 'scripts', 'hydra-counterparty-stub.mts'), {
			...process.env,
			STUB_PORT: String(STUB_PORT),
			STUB_HOST_URL: HOSTS[1].baseUrl,
			STUB_HOST_ADMIN_TOKEN: HOSTS[1].adminToken,
			STUB_MNEMONIC: fixture.outbound.remoteMnemonic,
			STUB_EXPECT_SIGNER: fixture.outbound.localAddress,
			STUB_ADVERTISE_HOST: '127.0.0.1',
		});
		await sleep(5_000);
		console.log(`  counterparty stub ready at http://127.0.0.1:${STUB_PORT}`);
	}

	banner(HOSTS, fixture);

	// Hold the process open; the children are the point.
	await new Promise(() => undefined);
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
