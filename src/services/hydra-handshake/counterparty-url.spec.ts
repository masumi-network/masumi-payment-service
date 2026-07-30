import { describe, expect, it } from '@jest/globals';
import { counterpartyOfferUrl, normalizeCounterpartyBaseUrl } from './counterparty-url';

describe('normalizeCounterpartyBaseUrl', () => {
	it('keeps a bare origin', () => {
		expect(normalizeCounterpartyBaseUrl('https://payments.example.com')).toBe('https://payments.example.com');
	});

	// The whole reason this exists: the admin UI shows an /api/v1 URL, so that is
	// what operators copy, and appending our path to it 404s.
	it('drops a trailing /api/v1', () => {
		expect(normalizeCounterpartyBaseUrl('https://payments.example.com/api/v1')).toBe('https://payments.example.com');
	});

	it('drops a trailing /api/v1 with a slash', () => {
		expect(normalizeCounterpartyBaseUrl('http://127.0.0.1:3001/api/v1/')).toBe('http://127.0.0.1:3001');
	});

	// A reverse proxy may mount the service under a prefix; that prefix is real
	// and must survive.
	it('keeps a path prefix that is not /api/v1', () => {
		expect(normalizeCounterpartyBaseUrl('https://example.com/masumi')).toBe('https://example.com/masumi');
	});

	it('keeps a prefix and drops /api/v1 after it', () => {
		expect(normalizeCounterpartyBaseUrl('https://example.com/masumi/api/v1')).toBe('https://example.com/masumi');
	});

	it('preserves a non-default port', () => {
		expect(normalizeCounterpartyBaseUrl('http://127.0.0.1:3002')).toBe('http://127.0.0.1:3002');
	});

	it.each(['', '   ', 'not a url', 'payments.example.com'])('rejects %p', (value) => {
		expect(() => normalizeCounterpartyBaseUrl(value)).toThrow();
	});

	// Offers are delivered by a server-side fetch, so a non-HTTP scheme is a way
	// to point this service at something that is not a counterparty at all.
	it.each(['file:///etc/passwd', 'ftp://example.com'])('rejects the scheme in %p', (value) => {
		expect(() => normalizeCounterpartyBaseUrl(value)).toThrow(/http or https/);
	});
});

describe('counterpartyOfferUrl', () => {
	it('appends the offer path exactly once', () => {
		expect(counterpartyOfferUrl('http://127.0.0.1:3001/api/v1')).toBe(
			'http://127.0.0.1:3001/api/v1/hydra/handshake/offer',
		);
	});

	it('builds the same URL from the origin form', () => {
		expect(counterpartyOfferUrl('http://127.0.0.1:3001')).toBe(counterpartyOfferUrl('http://127.0.0.1:3001/api/v1/'));
	});
});
