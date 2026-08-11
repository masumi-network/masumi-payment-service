import { describe, expect, it } from '@jest/globals';
import { HydraHostStatus } from '@/generated/prisma/client';
import { nextHostStatus, normalizeHostBaseUrl, normalizeHostToken } from './registry';

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

	it('requires an explicit opt-in for every HTTP Host URL', () => {
		expect(() => normalizeHostBaseUrl('http://10.0.0.8:8443')).toThrow(/allowInsecureHttp/);
		expect(() => normalizeHostBaseUrl('http://127.0.0.1:8443')).toThrow(/allowInsecureHttp/);
		expect(normalizeHostBaseUrl('http://127.0.0.1:8443', true)).toBe('http://127.0.0.1:8443');
		expect(normalizeHostBaseUrl('http://hydra.internal:8443', true)).toBe('http://hydra.internal:8443');
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

describe('normalizeHostToken', () => {
	const TOKEN = 'e2e-admin-a-0123456789abcdef0123456789abcdef';

	it('keeps a clean token unchanged', () => {
		expect(normalizeHostToken(TOKEN, 'adminToken')).toBe(TOKEN);
	});

	it.each([
		['a trailing newline from a terminal', `${TOKEN}\n`],
		['a leading space from a table cell', ` ${TOKEN}`],
		['both', `\t${TOKEN}\n`],
	])('trims %s', (_label, pasted) => {
		expect(normalizeHostToken(pasted, 'adminToken')).toBe(TOKEN);
	});

	// The observed failure: copying a row out of a table brings the label with
	// it. A bearer header is `Bearer` plus one run of non-space characters, so
	// the Host rejects this as a *malformed* header and answers 401 — which
	// reads as "wrong credential" while the stored value looks perfectly right.
	it('refuses a token with its label pasted in front', () => {
		expect(() => normalizeHostToken(`key\t${TOKEN}`, 'adminToken')).toThrow(/only the key itself/);
	});

	it.each([
		['an inner space', `e2e-admin a-0123`],
		['an inner tab', `e2e-admin\ta-0123`],
	])('refuses %s', (_label, pasted) => {
		expect(() => normalizeHostToken(pasted, 'userToken')).toThrow(/spaces or tabs/);
	});

	it('refuses a blank token', () => {
		expect(() => normalizeHostToken('   ', 'userToken')).toThrow();
	});

	it('names the field it rejected, so a form can point at it', () => {
		expect(() => normalizeHostToken(`key\t${TOKEN}`, 'userToken')).toThrow(/userToken/);
	});
});
