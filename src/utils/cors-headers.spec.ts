import { CORS_EXPOSED_HEADERS, CORS_EXPOSED_HEADERS_VALUE } from './cors-headers';

describe('CORS exposed headers', () => {
	it('exposes report download and retry metadata without duplicates', () => {
		expect(CORS_EXPOSED_HEADERS).toEqual([
			'Content-Range',
			'X-Total-Count',
			'Content-Disposition',
			'Content-Length',
			'Retry-After',
		]);
		expect(new Set(CORS_EXPOSED_HEADERS).size).toBe(CORS_EXPOSED_HEADERS.length);
		expect(CORS_EXPOSED_HEADERS_VALUE).toBe(CORS_EXPOSED_HEADERS.join(', '));
	});
});
