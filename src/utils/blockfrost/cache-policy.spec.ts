import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createRequire } from 'node:module';

// Resolve the same policy implementation that Blockfrost's HTTP client uses.
const localRequire = createRequire(import.meta.url);
const blockfrostRequire = createRequire(localRequire.resolve('@blockfrost/blockfrost-js'));
const gotRequire = createRequire(blockfrostRequire.resolve('got'));
const cacheableRequestRequire = createRequire(gotRequire.resolve('cacheable-request'));

type CacheRequest = {
	url: string;
	method: string;
	headers: Record<string, string>;
};
type CacheResponse = {
	status: number;
	headers: Record<string, string>;
};
type SerializedPolicy = { v: number };
type Policy = {
	toObject: () => SerializedPolicy;
	revalidatedPolicy: (
		request: CacheRequest,
		response: CacheResponse,
	) => {
		policy: Policy;
		modified: boolean;
		matches: boolean;
	};
	maxAge: () => number;
	satisfiesWithoutRevalidation: (request: CacheRequest) => boolean;
	evaluateRequest: (request: CacheRequest) => {
		response?: CacheResponse;
		revalidation?: { synchronous: boolean };
	};
};
const CachePolicy = cacheableRequestRequire('http-cache-semantics') as {
	new (request: CacheRequest, response: CacheResponse, options: { shared: boolean }): Policy;
	fromObject: (serialized: SerializedPolicy) => Policy;
};

const REQUEST: CacheRequest = {
	url: 'https://example.test/account',
	method: 'GET',
	headers: { host: 'example.test' },
};
const STALE_REQUEST: CacheRequest = {
	...REQUEST,
	headers: { ...REQUEST.headers, 'cache-control': 'max-stale=86400' },
};
const COOKIE = 'session=alice';

function policy(cacheControl: string, headers: Record<string, string> = {}, shared = true) {
	return new CachePolicy(
		REQUEST,
		{
			status: 200,
			headers: {
				date: new Date().toUTCString(),
				'cache-control': cacheControl,
				...headers,
			},
		},
		{ shared },
	);
}

beforeEach(() => {
	jest.useFakeTimers();
	jest.setSystemTime(new Date('2026-10-15T00:00:00Z'));
});
afterEach(() => {
	jest.useRealTimers();
});

describe('Blockfrost dependency cache policy security', () => {
	it('does not serve a shared cookie response through a client max-stale directive', () => {
		const cached = policy('max-age=600', { 'set-cookie': COOKIE });
		expect(cached.maxAge()).toBe(0);
		expect(cached.satisfiesWithoutRevalidation(STALE_REQUEST)).toBe(false);
		expect(cached.evaluateRequest(STALE_REQUEST).response).toBeUndefined();
	});

	it('does not serve a shared cookie response through stale-while-revalidate', () => {
		const cached = policy('max-age=600, stale-while-revalidate=86400', { 'set-cookie': COOKIE });
		jest.advanceTimersByTime(1_000);
		expect(cached.maxAge()).toBe(0);
		const evaluated = cached.evaluateRequest(REQUEST);
		expect(evaluated.response).toBeUndefined();
		expect(evaluated.revalidation?.synchronous).toBe(true);
	});

	it.each(['proxy-revalidate', 'no-cache', 'no-store', 'private'])(
		'does not let max-stale bypass a response with %s',
		(directive) => {
			const cached = policy(`max-age=600, ${directive}`);
			expect(cached.maxAge()).toBe(0);
			expect(cached.satisfiesWithoutRevalidation(STALE_REQUEST)).toBe(false);
			expect(cached.evaluateRequest(STALE_REQUEST).response).toBeUndefined();
		},
	);

	it('still serves an ordinary expired response when the client allows its age', () => {
		const cached = policy('max-age=60');
		jest.advanceTimersByTime(61_000);
		expect(cached.maxAge()).toBe(60);
		expect(cached.satisfiesWithoutRevalidation(STALE_REQUEST)).toBe(true);
		expect(cached.evaluateRequest(STALE_REQUEST).response?.status).toBe(200);
	});

	it('keeps the explicit public opt-in for shared cookie responses', () => {
		const cached = policy('public, max-age=60', { 'set-cookie': COOKIE });
		expect(cached.maxAge()).toBe(60);
		expect(cached.satisfiesWithoutRevalidation(REQUEST)).toBe(true);
		jest.advanceTimersByTime(61_000);
		expect(cached.satisfiesWithoutRevalidation(STALE_REQUEST)).toBe(true);
		expect(cached.evaluateRequest(STALE_REQUEST).response?.headers['set-cookie']).toBe(COOKIE);
	});
});

describe('cache policy alternate reuse paths', () => {
	it('keeps cookie protection after policy serialization', () => {
		const cached = policy('max-age=600, stale-while-revalidate=86400', { 'set-cookie': COOKIE });
		const serialized = JSON.parse(JSON.stringify(cached.toObject())) as SerializedPolicy;
		const restored = CachePolicy.fromObject(serialized);
		jest.advanceTimersByTime(1_000);
		expect(restored.maxAge()).toBe(0);
		expect(restored.satisfiesWithoutRevalidation(STALE_REQUEST)).toBe(false);
		expect(restored.evaluateRequest(REQUEST).response).toBeUndefined();
	});

	it('does not serve a protected cookie response after the clock moves backwards', () => {
		const cached = policy('max-age=600', { 'set-cookie': COOKIE });
		jest.setSystemTime(Date.now() - 1_000);
		expect(cached.maxAge()).toBe(0);
		expect(cached.satisfiesWithoutRevalidation(REQUEST)).toBe(false);
		expect(cached.evaluateRequest(REQUEST).response).toBeUndefined();
	});

	it.each(['cookie', 'private', 'no-cache', 'proxy-revalidate'])(
		'does not reuse %s data through stale-if-error after a 503 response',
		(directive) => {
			const headers: Record<string, string> = directive === 'cookie' ? { 'set-cookie': COOKIE } : {};
			const responseDirective = directive === 'cookie' ? '' : `, ${directive}`;
			const cached = policy(`max-age=60, stale-if-error=86400${responseDirective}`, headers);
			jest.advanceTimersByTime(61_000);
			const revalidated = cached.revalidatedPolicy(REQUEST, { status: 503, headers: {} });
			expect(revalidated.modified).toBe(true);
			expect(revalidated.matches).toBe(false);
			expect(revalidated.policy).not.toBe(cached);
		},
	);

	it('still allows ordinary stale-if-error reuse after a 503 response', () => {
		const cached = policy('max-age=60, stale-if-error=120');
		jest.advanceTimersByTime(61_000);
		const revalidated = cached.revalidatedPolicy(REQUEST, { status: 503, headers: {} });
		expect(revalidated.modified).toBe(false);
		expect(revalidated.matches).toBe(true);
		expect(revalidated.policy).toBe(cached);
	});

	it('keeps the explicit immutable opt-in for shared cookie responses', () => {
		const cached = policy('immutable, max-age=60', { 'set-cookie': COOKIE });
		expect(cached.maxAge()).toBe(60);
		expect(cached.satisfiesWithoutRevalidation(REQUEST)).toBe(true);
	});

	it('keeps cookie responses available to a personal cache', () => {
		const cached = policy('max-age=60', { 'set-cookie': COOKIE }, false);
		expect(cached.maxAge()).toBe(60);
		expect(cached.satisfiesWithoutRevalidation(REQUEST)).toBe(true);
		jest.advanceTimersByTime(61_000);
		expect(cached.satisfiesWithoutRevalidation(STALE_REQUEST)).toBe(true);
	});
});
