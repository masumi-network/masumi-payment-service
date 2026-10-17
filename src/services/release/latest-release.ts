/**
 * The newest published release of this project, from its GitHub releases.
 *
 * Every release so far is marked Pre-release, so `releases/latest` (which
 * skips pre-releases) would answer 404. The list is read instead, and the
 * highest plain `x.y.z` tag wins. Drafts are skipped.
 *
 * Fetched only when asked for and cached, so an instance asks GitHub at most
 * once per cache window. A failed check is cached for a shorter time and
 * reported as not checked, never as "up to date".
 */

import { logger } from '@masumi/payment-core/logger';
import { getOwnString, getOwnValue, isPlainObject } from '@masumi/payment-core/object-properties';
import { compareSemver } from './release-info';

export const RELEASES_API_URL =
	'https://api.github.com/repos/masumi-network/masumi-payment-service/releases?per_page=100';
export const LATEST_RELEASE_CACHE_MS = 6 * 60 * 60 * 1000;
export const LATEST_RELEASE_FAILURE_CACHE_MS = 15 * 60 * 1000;
const LATEST_RELEASE_TIMEOUT_MS = 10_000;

export type LatestRelease = {
	version: string;
	url: string;
	publishedAt: string | null;
};

export type LatestReleaseCheck = {
	latest: LatestRelease | null;
	/** When GitHub last answered. Null when no check has succeeded yet. */
	checkedAt: string | null;
	/** Why the last check failed, when it did. */
	error: string | null;
};

type CacheEntry = { check: LatestReleaseCheck; expiresAtMs: number };

let cache: CacheEntry | null = null;
let inFlight: Promise<LatestReleaseCheck> | null = null;

export function pickLatestRelease(body: unknown): LatestRelease | null {
	if (!Array.isArray(body)) return null;
	let best: LatestRelease | null = null;
	for (const entry of body) {
		if (!isPlainObject(entry) || getOwnValue(entry, 'draft') === true) continue;
		const tag = getOwnString(entry, 'tag_name');
		const url = getOwnString(entry, 'html_url');
		if (tag === undefined || url === undefined) continue;
		const version = tag.replace(/^v/, '');
		// Compared with itself first so a tag that is not x.y.z never wins by default.
		const comparison = compareSemver(version, best?.version ?? version);
		if (comparison === null || (best !== null && comparison <= 0)) continue;
		best = { version, url, publishedAt: getOwnString(entry, 'published_at') ?? null };
	}
	return best;
}

async function fetchLatestRelease(): Promise<LatestRelease | null> {
	const response = await fetch(RELEASES_API_URL, {
		headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'masumi-payment-service' },
		signal: AbortSignal.timeout(LATEST_RELEASE_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(`GitHub answered ${response.status}`);
	}
	return pickLatestRelease(await response.json());
}

export async function getLatestRelease(nowMs: number = Date.now()): Promise<LatestReleaseCheck> {
	if (cache !== null && cache.expiresAtMs > nowMs) return cache.check;
	// One request at a time: concurrent page loads share it.
	inFlight ??= (async () => {
		try {
			const latest = await fetchLatestRelease();
			const check = { latest, checkedAt: new Date(nowMs).toISOString(), error: null };
			cache = { check, expiresAtMs: nowMs + LATEST_RELEASE_CACHE_MS };
			return check;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.warn('[Release] could not check GitHub for the latest release', { error: message });
			// Keep the last good answer visible, but say the refresh failed.
			const check = { latest: null, checkedAt: null, ...cache?.check, error: message };
			cache = { check, expiresAtMs: nowMs + LATEST_RELEASE_FAILURE_CACHE_MS };
			return check;
		} finally {
			inFlight = null;
		}
	})();
	return await inFlight;
}

/** For tests. */
export function resetLatestReleaseCache(): void {
	cache = null;
	inFlight = null;
}
