import { describe, expect, it } from '@jest/globals';
import { normalizeHostBaseUrl } from './registry';

describe('normalizeHostBaseUrl', () => {
	it('keeps a plain origin', () => {
		expect(normalizeHostBaseUrl('https://hydra1.example.com')).toBe('https://hydra1.example.com');
	});

	// Trailing slashes are stripped so the unique (network, baseUrl) constraint
	// cannot be sidestepped by registering the same Host twice.
	it('strips trailing slashes so one Host cannot be registered twice', () => {
		expect(normalizeHostBaseUrl('https://hydra1.example.com/')).toBe('https://hydra1.example.com');
		expect(normalizeHostBaseUrl('https://hydra1.example.com///')).toBe('https://hydra1.example.com');
	});

	it('preserves a base path', () => {
		expect(normalizeHostBaseUrl('https://gw.example.com/hydra/')).toBe('https://gw.example.com/hydra');
	});

	it('keeps an explicit port', () => {
		expect(normalizeHostBaseUrl('https://hydra1.example.com:8443')).toBe('https://hydra1.example.com:8443');
	});

	// A credential in a URL ends up in logs, metrics and error messages; the
	// token belongs in a header.
	it('refuses embedded credentials', () => {
		expect(() => normalizeHostBaseUrl('https://user:pass@hydra1.example.com')).toThrow(/must not embed credentials/);
	});

	it('refuses a query string or fragment', () => {
		expect(() => normalizeHostBaseUrl('https://hydra1.example.com?token=x')).toThrow(/query string or fragment/);
		expect(() => normalizeHostBaseUrl('https://hydra1.example.com#frag')).toThrow(/query string or fragment/);
	});

	it('refuses a non-http scheme or a relative URL', () => {
		expect(() => normalizeHostBaseUrl('ws://hydra1.example.com')).toThrow(/must be http or https/);
		expect(() => normalizeHostBaseUrl('/hydra')).toThrow(/absolute URL/);
		expect(() => normalizeHostBaseUrl('not a url')).toThrow(/absolute URL/);
	});
});
