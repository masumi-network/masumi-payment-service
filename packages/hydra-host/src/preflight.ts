/**
 * What must exist on the machine before a node can start.
 *
 * A Host boots fine without either executable below and looks healthy: the
 * control plane answers, capabilities report, slots are free. The failure only
 * appears when someone provisions a node, and it appears in the wrong place —
 * the node exits within seconds, the supervisor retries five times and gives up
 * with "a restart is unlikely to fix it", and the actual cause
 * (`etcd: startProcess: find_executable: failed`) is in the node's own log file.
 *
 * So both are checked once, at boot, where the message can name the setting
 * that fixes it.
 */

import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';
import type { HostConfig } from './config.js';

/** Injected so the search can be tested without a filesystem. */
export type ExecutableProbe = {
	/** PATH as the OS presents it, unparsed. */
	pathValue: string | undefined;
	/** Whether this exact path is a file that can be executed. */
	isExecutable: (candidate: string) => boolean;
};

export function systemProbe(env: NodeJS.ProcessEnv = process.env): ExecutableProbe {
	return {
		pathValue: env.PATH,
		isExecutable: (candidate) => {
			try {
				if (!statSync(candidate).isFile()) return false;
				accessSync(candidate, constants.X_OK);
				return true;
			} catch {
				return false;
			}
		},
	};
}

/**
 * The path an OS exec would resolve `name` to, or null.
 *
 * A name carrying a separator is a path already and is never searched for on
 * PATH — that is how the shell treats it, and resolving `./hydra-node` against
 * PATH would report a different binary as present than the one that will run.
 */
export function resolveExecutable(name: string, probe: ExecutableProbe): string | null {
	if (name.includes(path.sep) || path.isAbsolute(name)) {
		return probe.isExecutable(name) ? name : null;
	}
	const directories = (probe.pathValue ?? '').split(path.delimiter).filter((entry) => entry.length > 0);
	for (const directory of directories) {
		const candidate = path.join(directory, name);
		if (probe.isExecutable(candidate)) return candidate;
	}
	return null;
}

export class HostPreflightError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'HostPreflightError';
	}
}

export function assertExecutablesAvailable(
	config: Pick<HostConfig, 'hydraNodeBin' | 'useSystemEtcd'>,
	probe: ExecutableProbe = systemProbe(),
): void {
	if (resolveExecutable(config.hydraNodeBin, probe) === null) {
		throw new HostPreflightError(
			`no hydra-node executable at ${config.hydraNodeBin}. Set HYDRA_NODE_BIN to the binary this Host should supervise ` +
				'(the container bakes one at /usr/local/bin/hydra-node; native mode has to supply its own).',
		);
	}

	// Only when we have told hydra-node to use the system copy. Left to itself it
	// extracts the etcd it embeds, and nothing needs to be on PATH.
	if (config.useSystemEtcd && resolveExecutable('etcd', probe) === null) {
		throw new HostPreflightError(
			'HYDRA_HOST_USE_SYSTEM_ETCD is on but no etcd executable is on PATH. Install a matching etcd, ' +
				'or set HYDRA_HOST_USE_SYSTEM_ETCD=false to let hydra-node extract the copy it embeds ' +
				'(which is what native mode outside the container wants; see docs/hydra-host-native-mode.md).',
		);
	}
}
