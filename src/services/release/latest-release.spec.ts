import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

let latest: typeof import('./latest-release');

beforeAll(async () => {
	latest = await import('./latest-release');
});

function release(tag: string, overrides: Record<string, unknown> = {}) {
	return {
		tag_name: tag,
		html_url: `https://github.com/masumi-network/masumi-payment-service/releases/tag/${tag}`,
		published_at: '2026-10-05T00:00:00Z',
		draft: false,
		prerelease: true,
		...overrides,
	};
}

const fetchMock = jest.fn<typeof fetch>();
const realFetch = global.fetch;

beforeEach(() => {
	latest.resetLatestReleaseCache();
	fetchMock.mockReset();
	global.fetch = fetchMock;
});

afterEach(() => {
	global.fetch = realFetch;
});

function answer(body: unknown, status = 200) {
	fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

describe('pickLatestRelease', () => {
	// Every release so far is a pre-release, so they must count.
	it('takes the highest version, pre-releases included, by number', () => {
		const picked = latest.pickLatestRelease([release('0.9.0'), release('0.29.0'), release('0.10.0')]);
		expect(picked?.version).toBe('0.29.0');
	});

	it('skips drafts and tags that are not x.y.z', () => {
		const picked = latest.pickLatestRelease([
			release('0.31.0', { draft: true }),
			release('nightly'),
			release('v0.30.0'),
		]);
		expect(picked?.version).toBe('0.30.0');
	});

	it('returns null for anything but a list', () => {
		expect(latest.pickLatestRelease({ message: 'Not Found' })).toBeNull();
	});
});

describe('getLatestRelease', () => {
	it('asks GitHub once per cache window', async () => {
		answer([release('0.29.0')]);
		const now = Date.parse('2026-10-17T10:00:00Z');

		await latest.getLatestRelease(now);
		const second = await latest.getLatestRelease(now + latest.LATEST_RELEASE_CACHE_MS - 1);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(second.latest?.version).toBe('0.29.0');
		await latest.getLatestRelease(now + latest.LATEST_RELEASE_CACHE_MS);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	// A failed check must never read as "up to date".
	it('reports a failed first check as not checked', async () => {
		answer({ message: 'rate limited' }, 403);

		const check = await latest.getLatestRelease(Date.now());

		expect(check).toEqual({ latest: null, checkedAt: null, error: 'GitHub answered 403' });
	});

	it('keeps the last good answer when a refresh fails, and says it failed', async () => {
		const now = Date.parse('2026-10-17T10:00:00Z');
		answer([release('0.29.0')]);
		await latest.getLatestRelease(now);
		fetchMock.mockRejectedValue(new Error('network down'));

		const check = await latest.getLatestRelease(now + latest.LATEST_RELEASE_CACHE_MS);

		expect(check.latest?.version).toBe('0.29.0');
		expect(check.error).toBe('network down');
	});
});
