import { OpenAPIRegistry, OpenApiGeneratorV3, extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from '@masumi/payment-core/zod';
import { registerReportPaths } from './docs';

extendZodWithOpenApi(z);

const registry = new OpenAPIRegistry();
const apiKeyAuth = registry.registerComponent('securitySchemes', 'API-Key', {
	type: 'apiKey',
	in: 'header',
	name: 'token',
});
registerReportPaths({ registry, apiKeyAuth });
const document = new OpenApiGeneratorV3(registry.definitions).generateDocument({
	openapi: '3.0.0',
	info: { version: '1.0.0', title: 'Reports test API' },
});

function operation(path: string, method: 'get' | 'post') {
	const value = document.paths[path]?.[method];
	if (value == null) throw new Error(`Missing ${method.toUpperCase()} ${path}`);
	return value;
}

function requestSchema(path: string) {
	return requestBody(path).content['application/json']?.schema;
}

function requestBody(path: string) {
	const requestBody = operation(path, 'post').requestBody;
	if (requestBody == null || '$ref' in requestBody) throw new Error(`Missing request body for ${path}`);
	return requestBody;
}

function successResponse(path: string, method: 'get' | 'post') {
	const response = operation(path, method).responses['200'];
	if (response == null || '$ref' in response) throw new Error(`Missing 200 response for ${method} ${path}`);
	return response;
}

function errorResponse(path: string, method: 'get' | 'post', statusCode: string) {
	const response = operation(path, method).responses[statusCode];
	if (response == null || '$ref' in response) {
		throw new Error(`Missing ${statusCode} response for ${method} ${path}`);
	}
	return response;
}

describe('transaction report OpenAPI docs', () => {
	it('registers every JSON and file export endpoint with read authentication', () => {
		const endpoints = [
			['/reports/facets', 'get'],
			['/reports/transactions', 'post'],
			['/reports/summary', 'post'],
			['/reports/transactions.csv', 'post'],
			['/reports/wallet-summary.csv', 'post'],
			['/reports/totals.csv', 'post'],
			['/reports/export.zip', 'post'],
		] as const;

		for (const [path, method] of endpoints) {
			expect(operation(path, method)).toMatchObject({
				tags: ['reports'],
				security: [{ 'API-Key': [] }],
			});
		}
	});

	it('documents the JSON response envelopes and report request schemas', () => {
		expect(successResponse('/reports/facets', 'get').content?.['application/json']).toBeDefined();
		expect(successResponse('/reports/transactions', 'post').content?.['application/json']).toBeDefined();
		expect(successResponse('/reports/summary', 'post').content?.['application/json']).toBeDefined();

		expect(requestSchema('/reports/transactions')).toMatchObject({
			allOf: expect.arrayContaining([
				expect.objectContaining({
					properties: expect.objectContaining({ paymentSourceId: expect.any(Object) }),
				}),
				expect.objectContaining({
					properties: expect.objectContaining({ cursor: expect.any(Object), limit: expect.any(Object) }),
				}),
			]),
		});

		const summarySchema = requestSchema('/reports/summary');
		expect(summarySchema).toMatchObject({
			allOf: expect.arrayContaining([
				expect.objectContaining({
					properties: expect.objectContaining({ paymentSourceId: expect.any(Object) }),
				}),
				expect.objectContaining({ properties: expect.objectContaining({ bucket: expect.any(Object) }) }),
			]),
		});
		for (const path of [
			'/reports/transactions.csv',
			'/reports/wallet-summary.csv',
			'/reports/totals.csv',
			'/reports/export.zip',
		]) {
			expect(requestSchema(path)).toEqual(summarySchema);
		}
	});

	it('requires every POST body and documents the runtime JSON error envelope', () => {
		for (const path of [
			'/reports/transactions',
			'/reports/summary',
			'/reports/transactions.csv',
			'/reports/wallet-summary.csv',
			'/reports/totals.csv',
			'/reports/export.zip',
		]) {
			expect(requestBody(path).required).toBe(true);
			expect(errorResponse(path, 'post', '400').content?.['application/json']?.schema).toBeDefined();
		}
		expect(errorResponse('/reports/facets', 'get', '401').content?.['application/json']?.schema).toBeDefined();
	});

	it('documents report size limits on facets and paginated transaction rows', () => {
		expect(errorResponse('/reports/facets', 'get', '413').content?.['application/json']?.schema).toBeDefined();
		expect(errorResponse('/reports/transactions', 'post', '413').content?.['application/json']?.schema).toBeDefined();
	});

	it('documents rate and capacity limits with Retry-After headers', () => {
		for (const [path, method] of [
			['/reports/facets', 'get'],
			['/reports/transactions', 'post'],
			['/reports/summary', 'post'],
			['/reports/transactions.csv', 'post'],
			['/reports/wallet-summary.csv', 'post'],
			['/reports/totals.csv', 'post'],
			['/reports/export.zip', 'post'],
		] as const) {
			for (const statusCode of ['429', '503']) {
				const response = errorResponse(path, method, statusCode);
				expect(response.content?.['application/json']?.schema).toBeDefined();
				expect(response.headers).toMatchObject({
					'Retry-After': { schema: { type: 'integer', minimum: 1 } },
				});
			}
		}
	});

	it.each([
		['/reports/transactions.csv', 'text/csv; charset=utf-8'],
		['/reports/wallet-summary.csv', 'text/csv; charset=utf-8'],
		['/reports/totals.csv', 'text/csv; charset=utf-8'],
		['/reports/export.zip', 'application/zip'],
	])('documents the binary response and download headers for %s', (path, mediaType) => {
		const response = successResponse(path, 'post');

		expect(response.content?.[mediaType]).toMatchObject({
			schema: { type: 'string', format: 'binary' },
		});
		expect(response.headers).toMatchObject({
			'Content-Disposition': { schema: { type: 'string' } },
			'Content-Length': { schema: { type: 'integer', minimum: 0 } },
		});
	});
});
