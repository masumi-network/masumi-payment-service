import { describe, expect, it } from '@jest/globals';
import { readReleaseInfo } from './release.js';

function env(values: Record<string, string>) {
	return { get: (key: string) => values[key] };
}

describe('readReleaseInfo', () => {
	it('reads a git describe version and commit baked in at build time', () => {
		expect(
			readReleaseInfo(
				env({
					MASUMI_RELEASE_VERSION: '0.29.0-157-g8db9e612',
					MASUMI_RELEASE_COMMIT: '8db9e612e4f1a2b3c4d5e6f708192a3b4c5d6e7f',
				}),
			),
		).toEqual({ version: '0.29.0-157-g8db9e612', commit: '8db9e612e4f1a2b3c4d5e6f708192a3b4c5d6e7f' });
	});

	it('accepts a bare release tag', () => {
		expect(readReleaseInfo(env({ MASUMI_RELEASE_VERSION: '0.30.0' })).version).toBe('0.30.0');
	});

	it('falls back to the platform commit when the build args were skipped', () => {
		expect(readReleaseInfo(env({ RAILWAY_GIT_COMMIT_SHA: 'ABCDEF1234567' }))).toEqual({
			version: null,
			commit: 'abcdef1234567',
		});
	});

	it('prefers the baked commit over the platform one', () => {
		expect(readReleaseInfo(env({ MASUMI_RELEASE_COMMIT: '1111111', RAILWAY_GIT_COMMIT_SHA: '2222222' })).commit).toBe(
			'1111111',
		);
	});

	it('reports malformed values as null instead of failing the boot', () => {
		expect(
			readReleaseInfo(env({ MASUMI_RELEASE_VERSION: 'latest; rm -rf /', MASUMI_RELEASE_COMMIT: 'not-a-hash' })),
		).toEqual({ version: null, commit: null });
	});

	it('reports nothing when no build information exists', () => {
		expect(readReleaseInfo(env({}))).toEqual({ version: null, commit: null });
	});
});
