/**
 * Environment for a two-Host end-to-end run on a developer machine.
 *
 * This is *native mode*: the Host is a plain Node process and spawns the
 * platform's own hydra-node build directly, with no container and no emulation.
 * The image exists for amd64 production; upstream publishes no linux/arm64
 * hydra-node, so on an arm64 Mac a container could only ever hold the amd64
 * binary, which dies with SIGILL under emulation. The application code is
 * identical either way — only `hydraNodeBin`, `dataDir` and the etcd source
 * differ, and all three are configuration.
 *
 * Two Hosts rather than one, because a Head needs two participants and in
 * production they belong to different organisations. Running them as separate
 * Hosts keeps that boundary real: separate registries, separate locks,
 * separate port ranges, separate tokens.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '..', '..');

/**
 * Roots to search for the `hydra-l2-flow/` harness assets.
 *
 * The scripts in that directory are tracked, but `.bin/` and `preprod/` are
 * gitignored — so a git worktree has the directory and none of the contents.
 * Checking the worktree first and the main clone second means this run works
 * from either without copying a 400 MB binary around.
 */
function vendorRoots(): string[] {
	const roots = [path.join(REPO_ROOT, 'hydra-l2-flow')];
	try {
		const commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
			cwd: REPO_ROOT,
			encoding: 'utf8',
		}).trim();
		roots.push(path.join(path.dirname(commonDir), 'hydra-l2-flow'));
	} catch {
		// Not a git checkout; the local path is the only candidate.
	}
	return roots;
}

/** First candidate that exists, or the first candidate so the error names a real path. */
function vendored(...segments: string[]): string {
	const candidates = vendorRoots().map((root) => path.join(root, ...segments));
	return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

/**
 * The Darwin hydra-node already vendored for the L2 flow harness.
 *
 * Deliberately the same binary the existing preprod harness uses, so a head
 * opened here is protocol-identical to one opened there.
 */
export const HYDRA_NODE_BIN = process.env.HYDRA_E2E_NODE_BIN ?? vendored('.bin', 'hydra-node');

export const BLOCKFROST_PROJECT_FILE = process.env.HYDRA_E2E_BLOCKFROST_FILE ?? vendored('preprod', 'blockfrost.txt');

/**
 * Signing key that pays to open a real head.
 *
 * Used only by the opt-in head-init phase. A Host generates each node's Cardano
 * key itself and those keys start empty, so something already funded has to
 * seed them.
 */
export const FUNDING_SIGNING_KEY_FILE =
	process.env.HYDRA_E2E_FUNDING_KEY ?? vendored('preprod', 'purchasing-cardano.sk');

export const LEDGER_PARAMS_FILE = path.join(REPO_ROOT, 'packages', 'hydra-host', 'params', 'preprod.json');

export const RUN_DIR = process.env.HYDRA_E2E_DIR ?? path.join(REPO_ROOT, '.hydra-e2e');
export const LOG_DIR = path.join(RUN_DIR, 'logs');

/** Long enough to satisfy the Host's own 32-character minimum, and distinct per tier. */
function token(host: string, tier: string): string {
	return `e2e-${tier}-${host}-0123456789abcdef0123456789abcdef`;
}

export type HostSpec = {
	name: string;
	/** Control-plane port the payment service talks to. */
	controlPort: number;
	baseUrl: string;
	adminToken: string;
	userToken: string;
	dataDir: string;
	/**
	 * Peer, API and monitoring port ranges.
	 *
	 * hydra-node derives its etcd client port from the peer port (peer − 2622),
	 * so the two Hosts' peer ranges must be far enough apart that their derived
	 * etcd ranges do not collide either: 5001→2379 and 5101→2479.
	 */
	peerPortStart: number;
	apiPortStart: number;
	monitoringPortStart: number;
	capacity: number;
	/** Counterparty-facing plane. Separate per Host here because both share a machine. */
	exchangePort: number;
};

export const HOST_A: HostSpec = {
	name: 'hostA',
	controlPort: 18443,
	baseUrl: 'http://127.0.0.1:18443',
	adminToken: token('a', 'admin'),
	userToken: token('a', 'user'),
	dataDir: path.join(RUN_DIR, 'hostA'),
	peerPortStart: 5001,
	apiPortStart: 4001,
	monitoringPortStart: 6001,
	capacity: 8,
	exchangePort: 18543,
};

export const HOST_B: HostSpec = {
	name: 'hostB',
	controlPort: 18444,
	baseUrl: 'http://127.0.0.1:18444',
	adminToken: token('b', 'admin'),
	userToken: token('b', 'user'),
	dataDir: path.join(RUN_DIR, 'hostB'),
	peerPortStart: 5101,
	apiPortStart: 4101,
	monitoringPortStart: 6101,
	capacity: 8,
	exchangePort: 18544,
};

export const HOSTS = [HOST_A, HOST_B];

/**
 * Both Hosts advertise on loopback.
 *
 * In production this is the public hostname of the reverse proxy's L4 peer
 * plane; here the two nodes genuinely dial each other over 127.0.0.1, which is
 * the same code path with a shorter wire.
 */
export const PUBLIC_HOST = '127.0.0.1';

export function hostEnv(spec: HostSpec): NodeJS.ProcessEnv {
	return {
		...process.env,
		HYDRA_HOST_DATA_DIR: spec.dataDir,
		HYDRA_HOST_PORT: String(spec.controlPort),
		HYDRA_HOST_EXCHANGE_PORT: String(spec.exchangePort),
		HYDRA_HOST_PUBLIC_HOST: PUBLIC_HOST,
		HYDRA_HOST_NETWORK: 'preprod',
		HYDRA_HOST_ADMIN_TOKEN: spec.adminToken,
		HYDRA_HOST_USER_TOKEN: spec.userToken,
		HYDRA_HOST_PEER_PORT_START: String(spec.peerPortStart),
		HYDRA_HOST_API_PORT_START: String(spec.apiPortStart),
		HYDRA_HOST_MONITORING_PORT_START: String(spec.monitoringPortStart),
		HYDRA_HOST_PEER_PORT_COUNT: String(spec.capacity),
		HYDRA_NODE_BIN: HYDRA_NODE_BIN,
		BLOCKFROST_PROJECT_FILE: BLOCKFROST_PROJECT_FILE,
		HYDRA_HOST_LEDGER_PARAMS_FILE: LEDGER_PARAMS_FILE,
		// No system etcd on macOS; let hydra-node extract and run its own copy.
		// The image bakes a matching 3.5.25 instead and sets this to true.
		HYDRA_HOST_USE_SYSTEM_ETCD: 'false',
		// A drain that waits two minutes makes an interactive run unusable, and
		// the drain logic under test is the same at any timeout.
		HYDRA_HOST_DRAIN_TIMEOUT_MS: process.env.HYDRA_E2E_DRAIN_TIMEOUT_MS ?? '20000',
	};
}

/** Fail before spawning anything, so a missing prerequisite is not a mystery later. */
export function assertPrerequisites(): string[] {
	const problems: string[] = [];
	for (const [label, file] of [
		['hydra-node binary', HYDRA_NODE_BIN],
		['blockfrost project file', BLOCKFROST_PROJECT_FILE],
		['ledger protocol parameters', LEDGER_PARAMS_FILE],
	] as const) {
		if (!fs.existsSync(file)) {
			problems.push(`${label} not found at ${file}`);
		}
	}
	return problems;
}

/**
 * Start from an empty run directory.
 *
 * A previous run's registry would make this one resume its nodes, which are
 * peered to ports and keys that no longer exist. Durability is still tested —
 * within a run, by killing and restarting a Host — but across runs a clean
 * slate is what makes results comparable. Set HYDRA_E2E_KEEP=1 to inspect a
 * previous run's state instead.
 */
export function ensureRunDirs(): void {
	if (process.env.HYDRA_E2E_KEEP !== '1') {
		fs.rmSync(RUN_DIR, { recursive: true, force: true });
	}
	fs.mkdirSync(LOG_DIR, { recursive: true });
	for (const spec of HOSTS) {
		fs.mkdirSync(spec.dataDir, { recursive: true });
	}
}
