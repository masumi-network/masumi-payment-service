/**
 * Which build of this project is running, and whether a newer release exists.
 *
 * One version covers the whole stack: a release tag builds both the payment
 * service image and the Hydra Host image. The values are baked in at build time
 * (`MASUMI_RELEASE_VERSION`, `MASUMI_RELEASE_COMMIT`) because `.git` is not in
 * the Docker build context. The Host reads the same variables in
 * `packages/hydra-host/src/release.ts`; the patterns below must stay equal.
 */

export type ReleaseInfo = {
	/** `git describe --tags --long` output, e.g. `0.29.0-5-gabc1234`, or a bare tag. */
	version: string | null;
	/** Full or abbreviated commit hash. */
	commit: string | null;
};

export type DescribedRelease = ReleaseInfo & {
	/** The release tag the build starts from, without a leading `v`. */
	tag: string | null;
	/** Commits on top of `tag`. Zero for a build of the tag itself. */
	commitsAhead: number | null;
	/** Built from a working tree with uncommitted changes. */
	dirty: boolean;
};

export const RELEASE_VERSION_PATTERN = /^v?\d+\.\d+\.\d+(?:-\d+-g[0-9a-f]{4,40})?(?:-dirty)?$/;
export const RELEASE_COMMIT_PATTERN = /^[0-9a-f]{7,40}$/;
const DESCRIBE_PATTERN = /^v?(\d+\.\d+\.\d+)(?:-(\d+)-g([0-9a-f]{4,40}))?(-dirty)?$/;
const SEMVER_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)$/;

function normalize(value: string | null | undefined, pattern: RegExp): string | null {
	const trimmed = value?.trim().toLowerCase();
	return trimmed !== undefined && pattern.test(trimmed) ? trimmed : null;
}

/** Malformed values become null: this is a label, and a label must not fail a boot. */
export function normalizeReleaseInfo(
	version: string | null | undefined,
	commit: string | null | undefined,
): ReleaseInfo {
	return {
		version: normalize(version, RELEASE_VERSION_PATTERN),
		commit: normalize(commit, RELEASE_COMMIT_PATTERN),
	};
}

export function readServiceRelease(env: NodeJS.ProcessEnv = process.env): ReleaseInfo {
	const release = normalizeReleaseInfo(env.MASUMI_RELEASE_VERSION, env.MASUMI_RELEASE_COMMIT);
	// Railway sets this for Git-sourced deploys, so a build without the build
	// args still reports its commit.
	return release.commit === null
		? { ...release, commit: normalize(env.RAILWAY_GIT_COMMIT_SHA, RELEASE_COMMIT_PATTERN) }
		: release;
}

export function describeRelease(release: ReleaseInfo): DescribedRelease {
	const match = release.version === null ? null : DESCRIBE_PATTERN.exec(release.version);
	if (!match) {
		return { ...release, tag: null, commitsAhead: null, dirty: false };
	}
	return {
		...release,
		tag: match[1],
		commitsAhead: match[2] === undefined ? 0 : Number(match[2]),
		// The describe hash is the build's own commit, so it fills a missing one.
		commit: release.commit ?? match[3] ?? null,
		dirty: match[4] !== undefined,
	};
}

/** Negative when `a` is older than `b`. Null when either is not a plain `x.y.z`. */
export function compareSemver(a: string, b: string): number | null {
	const left = SEMVER_PATTERN.exec(a);
	const right = SEMVER_PATTERN.exec(b);
	if (!left || !right) return null;
	for (let index = 1; index <= 3; index++) {
		const difference = Number(left[index]) - Number(right[index]);
		if (difference !== 0) return difference;
	}
	return 0;
}

/**
 * Whether `latest` is newer than the running build. Null when it cannot be
 * told: no latest release known, or a build that reports no release tag.
 * A build ahead of its tag is on that tag's line, so the same tag is current.
 */
export function isUpdateAvailable(running: DescribedRelease, latest: string | null): boolean | null {
	if (latest === null || running.tag === null) return null;
	const comparison = compareSemver(running.tag, latest);
	return comparison === null ? null : comparison < 0;
}
