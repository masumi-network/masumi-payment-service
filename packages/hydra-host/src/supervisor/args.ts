/**
 * Builds the argv for one supervised hydra-node process.
 *
 * This module is deliberately pure so the security invariants it enforces can
 * be asserted in tests rather than reviewed by eye:
 *
 *  - the client API always binds loopback, so a counterparty has no route to an
 *    unauthenticated API that can close a head (and `GET /config` discloses
 *    signing-key paths);
 *  - `--persistence-rotate-after` is never emitted, because the payment service
 *    permanently fail-closes a session that emits `EventLogRotated`;
 *  - `--advertise` is always explicit, since it is a participant identity on
 *    the wire (`msg-<advertise>`, `alive-<advertise>`) and not merely an
 *    address.
 */

import path from 'node:path';

/** Never configurable. See the module note. */
export const API_BIND_HOST = '127.0.0.1';

export type HydraNodeLaunchSpec = {
	nodeId: string;
	nodeDir: string;
	network: 'preprod' | 'mainnet';
	apiPort: number;
	peerPort: number;
	monitoringPort: number;
	/** Publicly reachable `host:port`; must match what the counterparty configures. */
	advertise: string;
	/** Counterparty `host:port` values. Hostnames preferred so a peer IP change needs no restart. */
	peers: string[];
	peerHydraVerificationKeyFiles: string[];
	peerCardanoVerificationKeyFiles: string[];
	ledgerProtocolParametersFile: string;
	blockfrostProjectFile: string;
	contestationPeriodSeconds: number;
	depositPeriodSeconds: number;
	unsyncedPeriodSeconds: number;
	useSystemEtcd?: boolean;
};

export class LaunchSpecError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'LaunchSpecError';
	}
}

const HOST_PORT_PATTERN = /^[A-Za-z0-9._-]+:\d{1,5}$/;

function assertHostPort(value: string, field: string): void {
	if (!HOST_PORT_PATTERN.test(value)) {
		throw new LaunchSpecError(`${field} must be "<host>:<port>", received ${JSON.stringify(value)}`);
	}
	const port = Number(value.slice(value.lastIndexOf(':') + 1));
	if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
		throw new LaunchSpecError(`${field} carries an invalid port: ${JSON.stringify(value)}`);
	}
}

function assertPort(value: number, field: string): void {
	if (!Number.isSafeInteger(value) || value < 1 || value > 65535) {
		throw new LaunchSpecError(`${field} must be a valid TCP port, received ${String(value)}`);
	}
}

function assertPositiveSeconds(value: number, field: string): void {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new LaunchSpecError(`${field} must be a positive whole number of seconds`);
	}
}

export function buildHydraNodeArgs(spec: HydraNodeLaunchSpec): string[] {
	assertPort(spec.apiPort, 'apiPort');
	assertPort(spec.peerPort, 'peerPort');
	assertPort(spec.monitoringPort, 'monitoringPort');
	assertHostPort(spec.advertise, 'advertise');
	assertPositiveSeconds(spec.contestationPeriodSeconds, 'contestationPeriodSeconds');
	assertPositiveSeconds(spec.depositPeriodSeconds, 'depositPeriodSeconds');
	assertPositiveSeconds(spec.unsyncedPeriodSeconds, 'unsyncedPeriodSeconds');

	if (spec.peers.length === 0) {
		throw new LaunchSpecError('a node cannot start before its peers are known; --initial-cluster is fixed at boot');
	}
	spec.peers.forEach((peer, index) => assertHostPort(peer, `peers[${index}]`));

	if (spec.peers.includes(spec.advertise)) {
		throw new LaunchSpecError('advertise must not appear in peers; a node would list itself as its own peer');
	}
	if (new Set(spec.peers).size !== spec.peers.length) {
		throw new LaunchSpecError('peers contains duplicates; etcd requires a well-formed initial cluster');
	}
	if (spec.peerHydraVerificationKeyFiles.length !== spec.peers.length) {
		throw new LaunchSpecError('each peer needs exactly one hydra verification key');
	}
	if (spec.peerCardanoVerificationKeyFiles.length !== spec.peers.length) {
		throw new LaunchSpecError('each peer needs exactly one cardano verification key');
	}

	const keysDir = path.join(spec.nodeDir, 'keys');
	const args: string[] = [
		'--node-id',
		spec.nodeId,
		// Loopback only. A published API would be unauthenticated and could be
		// used to close the head.
		'--api-host',
		API_BIND_HOST,
		'--api-port',
		String(spec.apiPort),
		'--listen',
		`0.0.0.0:${spec.peerPort}`,
		'--advertise',
		spec.advertise,
		'--monitoring-port',
		String(spec.monitoringPort),
	];

	for (const peer of spec.peers) {
		args.push('--peer', peer);
	}
	for (const file of spec.peerHydraVerificationKeyFiles) {
		args.push('--hydra-verification-key', file);
	}
	for (const file of spec.peerCardanoVerificationKeyFiles) {
		args.push('--cardano-verification-key', file);
	}

	args.push(
		'--hydra-signing-key',
		path.join(keysDir, 'hydra.sk'),
		'--cardano-signing-key',
		path.join(keysDir, 'cardano.sk'),
		'--ledger-protocol-parameters',
		spec.ledgerProtocolParametersFile,
		'--network',
		spec.network,
		'--blockfrost',
		spec.blockfrostProjectFile,
		'--persistence-dir',
		path.join(spec.nodeDir, 'persistence'),
		'--contestation-period',
		`${spec.contestationPeriodSeconds}s`,
		'--deposit-period',
		`${spec.depositPeriodSeconds}s`,
		'--unsynced-period',
		`${spec.unsyncedPeriodSeconds}s`,
	);

	if (spec.useSystemEtcd !== false) {
		// Use the etcd baked into the image rather than letting hydra-node
		// re-extract its embedded copy into the persistence volume on every boot.
		args.push('--use-system-etcd');
	}

	return args;
}
