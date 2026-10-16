export const CORS_EXPOSED_HEADERS = [
	'Content-Range',
	'X-Total-Count',
	'Content-Disposition',
	'Content-Length',
	'Retry-After',
] as const;

export const CORS_EXPOSED_HEADERS_VALUE = CORS_EXPOSED_HEADERS.join(', ');
