/**
 * Host configuration, parsed once at boot and fail-fast.
 *
 * A misconfigured Host must refuse to start rather than come up and then strand
 * a head: an unreachable public host produces an advertise address the
 * counterparty cannot dial, and a drift guard above the node's unsynced period
 * never fires in time to help.
 */

import { validateDriftThresholds, type DriftThresholds } from './supervisor/drift.js';
import { validatePortLayout, type PortLayout } from './registry/ports.js';

export type HostConfig = {
	dataDir: string;
	hydraNodeBin: string;
	listenPort: number;
	/**
	 * Port for the counterparty-facing Exchange Plane.
	 *
	 * Separate from the control plane so the two security models cannot be
	 * confused by a routing mistake, and so a deployment may publish one without
	 * the other.
	 */
	exchangePort: number;
	/** Public hostname used to build every node's advertise address. */
	publicHost: string;
	network: 'preprod' | 'mainnet';
	blockfrostProjectFile: string;
	ledgerProtocolParametersFile: string;
	adminToken: string;
	userToken: string;
	ports: PortLayout;
	drift: DriftThresholds;
	defaultContestationPeriodSeconds: number;
	defaultDepositPeriodSeconds: number;
	defaultUnsyncedPeriodSeconds: number;
	/** How long a provisioned-but-unacknowledged node survives before the reaper removes it. */
	escrowTtlSeconds: number;
	drainTimeoutMs: number;
	/**
	 * Use an etcd from PATH instead of the copy hydra-node extracts.
	 *
	 * True in the image, which bakes a matching etcd. False when running the
	 * Host natively on a machine with no system etcd — notably macOS, where the
	 * native hydra-node is the only build that executes at all.
	 */
	useSystemEtcd: boolean;
	/**
	 * Whether to start each node's Prometheus server.
	 *
	 * Off by default: hydra-node has no `--monitoring-host`, so the server binds
	 * every interface and cannot be confined to loopback the way the client API
	 * is. Turn it on only where the monitoring range is firewalled.
	 */
	monitoringEnabled: boolean;
};

export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ConfigError';
	}
}

export type EnvSource = { get(key: string): string | undefined };

export const processEnv: EnvSource = { get: (key) => process.env[key] };

function required(env: EnvSource, key: string): string {
	const value = env.get(key)?.trim();
	if (value === undefined || value.length === 0) {
		throw new ConfigError(`${key} is required`);
	}
	return value;
}

function optional(env: EnvSource, key: string, fallback: string): string {
	const value = env.get(key)?.trim();
	return value === undefined || value.length === 0 ? fallback : value;
}

function integer(env: EnvSource, key: string, fallback: number): number {
	const raw = env.get(key)?.trim();
	if (raw === undefined || raw.length === 0) {
		return fallback;
	}
	const parsed = Number(raw);
	if (!Number.isSafeInteger(parsed)) {
		throw new ConfigError(`${key} must be a whole number, received ${JSON.stringify(raw)}`);
	}
	return parsed;
}

const HOSTNAME_PATTERN = /^[A-Za-z0-9._-]+$/;

export function loadHostConfig(env: EnvSource = processEnv): HostConfig {
	const publicHost = required(env, 'HYDRA_HOST_PUBLIC_HOST');
	if (!HOSTNAME_PATTERN.test(publicHost)) {
		throw new ConfigError('HYDRA_HOST_PUBLIC_HOST must be a bare hostname or IP, with no scheme, port or path');
	}

	const network = optional(env, 'HYDRA_HOST_NETWORK', 'preprod');
	if (network !== 'preprod' && network !== 'mainnet') {
		throw new ConfigError(`HYDRA_HOST_NETWORK must be "preprod" or "mainnet", received ${JSON.stringify(network)}`);
	}

	const adminToken = required(env, 'HYDRA_HOST_ADMIN_TOKEN');
	const userToken = required(env, 'HYDRA_HOST_USER_TOKEN');
	if (adminToken === userToken) {
		throw new ConfigError(
			'HYDRA_HOST_ADMIN_TOKEN and HYDRA_HOST_USER_TOKEN must differ; the tiers exist to separate fleet management from node operation',
		);
	}
	for (const [key, token] of [
		['HYDRA_HOST_ADMIN_TOKEN', adminToken],
		['HYDRA_HOST_USER_TOKEN', userToken],
	] as const) {
		if (token.length < 32) {
			throw new ConfigError(
				`${key} must be at least 32 characters; it is the only thing in front of an unauthenticated node API`,
			);
		}
	}

	const ports: PortLayout = {
		peerStart: integer(env, 'HYDRA_HOST_PEER_PORT_START', 5001),
		apiStart: integer(env, 'HYDRA_HOST_API_PORT_START', 4001),
		monitoringStart: integer(env, 'HYDRA_HOST_MONITORING_PORT_START', 6001),
		capacity: integer(env, 'HYDRA_HOST_PEER_PORT_COUNT', 32),
	};
	validatePortLayout(ports);

	const defaultUnsyncedPeriodSeconds = integer(env, 'HYDRA_HOST_UNSYNCED_PERIOD_SECONDS', 1800);
	const drift: DriftThresholds = {
		targetMs: integer(env, 'HYDRA_HOST_DRIFT_TARGET_MS', 180_000),
		guardMs: integer(env, 'HYDRA_HOST_DRIFT_GUARD_MS', 400_000),
	};
	validateDriftThresholds(drift, defaultUnsyncedPeriodSeconds * 1000);

	return {
		dataDir: optional(env, 'HYDRA_HOST_DATA_DIR', '/data'),
		hydraNodeBin: optional(env, 'HYDRA_NODE_BIN', '/usr/local/bin/hydra-node'),
		listenPort: integer(env, 'HYDRA_HOST_PORT', 8443),
		exchangePort: integer(env, 'HYDRA_HOST_EXCHANGE_PORT', 8444),
		publicHost,
		network,
		blockfrostProjectFile: optional(env, 'BLOCKFROST_PROJECT_FILE', '/run/secrets/blockfrost.txt'),
		ledgerProtocolParametersFile: optional(env, 'HYDRA_HOST_LEDGER_PARAMS_FILE', `/opt/hydra/params/${network}.json`),
		adminToken,
		userToken,
		ports,
		drift,
		defaultContestationPeriodSeconds: integer(env, 'HYDRA_HOST_CONTESTATION_PERIOD_SECONDS', 220),
		defaultDepositPeriodSeconds: integer(env, 'HYDRA_HOST_DEPOSIT_PERIOD_SECONDS', 300),
		defaultUnsyncedPeriodSeconds,
		escrowTtlSeconds: integer(env, 'HYDRA_HOST_ESCROW_TTL_SECONDS', 3600),
		drainTimeoutMs: integer(env, 'HYDRA_HOST_DRAIN_TIMEOUT_MS', 120_000),
		useSystemEtcd: optional(env, 'HYDRA_HOST_USE_SYSTEM_ETCD', 'true') !== 'false',
		monitoringEnabled: optional(env, 'HYDRA_HOST_MONITORING_ENABLED', 'false') === 'true',
	};
}

/** `host:port` a counterparty must dial. Both sides must configure this identically. */
export function advertiseAddress(config: HostConfig, peerPort: number): string {
	return `${config.publicHost}:${peerPort}`;
}
