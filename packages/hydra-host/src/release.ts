/**
 * Which build of this project the Host runs.
 *
 * The image is the unit of release: Host code, its dependencies, the Node
 * runtime, etcd and hydra-node all change together when it is redeployed. So
 * the payment service compares this value, not `hydraVersion`, to tell an
 * operator that a newer release exists.
 *
 * Both values are baked in at build time (`MASUMI_RELEASE_VERSION`,
 * `MASUMI_RELEASE_COMMIT`), because `.git` is not in the Docker build context.
 * A build that skipped the build args still reports its commit when the
 * platform provides one (Railway sets `RAILWAY_GIT_COMMIT_SHA` for Git-sourced
 * deploys).
 *
 * A malformed value is reported as null instead of failing the boot: this is a
 * label for an operator, and a Host that refuses to start over a label strands
 * every head it serves.
 */

import type { EnvSource } from './config.js';

export type ReleaseInfo = {
	/** `git describe --tags --long` output, e.g. `0.29.0-5-gabc1234`, or a bare tag. */
	version: string | null;
	/** Full or abbreviated commit hash. */
	commit: string | null;
};

const VERSION_PATTERN = /^v?\d+\.\d+\.\d+(?:-\d+-g[0-9a-f]{4,40})?(?:-dirty)?$/;
const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/;

function read(env: EnvSource, key: string, pattern: RegExp): string | null {
	const value = env.get(key)?.trim().toLowerCase();
	return value !== undefined && pattern.test(value) ? value : null;
}

export function readReleaseInfo(env: EnvSource): ReleaseInfo {
	return {
		version: read(env, 'MASUMI_RELEASE_VERSION', VERSION_PATTERN),
		commit: read(env, 'MASUMI_RELEASE_COMMIT', COMMIT_PATTERN) ?? read(env, 'RAILWAY_GIT_COMMIT_SHA', COMMIT_PATTERN),
	};
}
