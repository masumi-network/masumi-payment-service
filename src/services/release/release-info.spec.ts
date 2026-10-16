import { describe, expect, it } from '@jest/globals';
import { compareSemver, describeRelease, isUpdateAvailable, readServiceRelease } from './release-info';

describe('readServiceRelease', () => {
	it('reads the baked-in version and commit', () => {
		expect(readServiceRelease({ MASUMI_RELEASE_VERSION: '0.29.0', MASUMI_RELEASE_COMMIT: 'ABC1234' })).toEqual({
			version: '0.29.0',
			commit: 'abc1234',
		});
	});

	it('falls back to the Railway commit when the build args were skipped', () => {
		expect(readServiceRelease({ RAILWAY_GIT_COMMIT_SHA: 'a'.repeat(40) })).toEqual({
			version: null,
			commit: 'a'.repeat(40),
		});
	});

	// A label must never fail a boot or carry markup into the UI.
	it('drops malformed values', () => {
		expect(readServiceRelease({ MASUMI_RELEASE_VERSION: 'latest', MASUMI_RELEASE_COMMIT: '<b>' })).toEqual({
			version: null,
			commit: null,
		});
	});
});

describe('describeRelease', () => {
	it('splits a describe string into tag, distance and commit', () => {
		expect(describeRelease({ version: '0.29.0-5-gabc1234', commit: null })).toEqual({
			version: '0.29.0-5-gabc1234',
			commit: 'abc1234',
			tag: '0.29.0',
			commitsAhead: 5,
			dirty: false,
		});
	});

	it('reads a bare tag as zero commits ahead', () => {
		expect(describeRelease({ version: 'v0.29.0', commit: 'f'.repeat(40) })).toMatchObject({
			tag: '0.29.0',
			commitsAhead: 0,
			commit: 'f'.repeat(40),
		});
	});

	it('flags a dirty build', () => {
		expect(describeRelease({ version: '0.29.0-0-gabc1234-dirty', commit: null }).dirty).toBe(true);
	});

	it('keeps the commit when there is no version', () => {
		expect(describeRelease({ version: null, commit: 'abc1234' })).toMatchObject({ tag: null, commit: 'abc1234' });
	});
});

describe('compareSemver', () => {
	it('compares numerically, not as text', () => {
		expect(compareSemver('0.9.0', '0.10.0')).toBeLessThan(0);
		expect(compareSemver('1.0.0', '0.99.99')).toBeGreaterThan(0);
		expect(compareSemver('v0.29.0', '0.29.0')).toBe(0);
	});

	it('refuses anything but x.y.z', () => {
		expect(compareSemver('0.29.0-rc1', '0.29.0')).toBeNull();
	});
});

describe('isUpdateAvailable', () => {
	const running = (version: string | null) => describeRelease({ version, commit: null });

	it('is true when a newer release exists', () => {
		expect(isUpdateAvailable(running('0.29.0'), '0.30.0')).toBe(true);
	});

	// Commits on top of the newest tag are newer than it, not behind it.
	it('is false for a build ahead of the newest tag', () => {
		expect(isUpdateAvailable(running('0.30.0-12-gabc1234'), '0.30.0')).toBe(false);
	});

	it('is null when it cannot be told', () => {
		expect(isUpdateAvailable(running(null), '0.30.0')).toBeNull();
		expect(isUpdateAvailable(running('0.29.0'), null)).toBeNull();
	});
});
