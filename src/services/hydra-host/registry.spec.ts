import { describe, expect, it } from '@jest/globals';
import { HydraHostStatus } from '@/generated/prisma/client';
import { nextHostStatus, normalizeHostBaseUrl } from './registry';

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

describe('nextHostStatus', () => {
	it('marks a healthy host Active and a failing one Unreachable', () => {
		expect(nextHostStatus(HydraHostStatus.Active, true)).toBe(HydraHostStatus.Active);
		expect(nextHostStatus(HydraHostStatus.Active, false)).toBe(HydraHostStatus.Unreachable);
	});

	it('recovers an unreachable host once it answers again', () => {
		expect(nextHostStatus(HydraHostStatus.Unreachable, true)).toBe(HydraHostStatus.Active);
		expect(nextHostStatus(HydraHostStatus.Unreachable, false)).toBe(HydraHostStatus.Unreachable);
	});

	// The regression this guards: Draining survived a successful probe but was
	// overwritten by a FAILED one, so Draining -> fail -> succeed silently
	// returned the host to Active and it began accepting placements again,
	// undoing the drain the operator had started.
	it('never overrides Draining, in either direction', () => {
		expect(nextHostStatus(HydraHostStatus.Draining, true)).toBe(HydraHostStatus.Draining);
		expect(nextHostStatus(HydraHostStatus.Draining, false)).toBe(HydraHostStatus.Draining);
	});

	it('never overrides Disabled, in either direction', () => {
		expect(nextHostStatus(HydraHostStatus.Disabled, true)).toBe(HydraHostStatus.Disabled);
		expect(nextHostStatus(HydraHostStatus.Disabled, false)).toBe(HydraHostStatus.Disabled);
	});

	// A drain that a probe could revert would be worse than no drain at all,
	// because the operator believes the host is emptying.
	it('is stable across any number of probe results', () => {
		let status: HydraHostStatus = HydraHostStatus.Draining;
		for (const ok of [false, true, false, true, true]) {
			status = nextHostStatus(status, ok);
		}
		expect(status).toBe(HydraHostStatus.Draining);
	});
});
