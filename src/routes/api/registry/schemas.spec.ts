import { RegistryEntryType } from '@/generated/prisma/enums';
import { getRegistryEndpointError } from './schemas';

describe('getRegistryEndpointError', () => {
	it('treats an absent type as Standard (requires apiBaseUrl)', () => {
		expect(getRegistryEndpointError({ apiBaseUrl: 'https://a.example' })).toBeNull();
		expect(getRegistryEndpointError({})).toBe('Standard agents require apiBaseUrl');
	});

	it('requires the matching endpoint field per type', () => {
		expect(
			getRegistryEndpointError({ type: RegistryEntryType.OpenApi, openApiSpecUrl: 'https://a/oapi.json' }),
		).toBeNull();
		expect(getRegistryEndpointError({ type: RegistryEntryType.OpenApi })).toBe('OpenApi agents require openApiSpecUrl');
		expect(
			getRegistryEndpointError({ type: RegistryEntryType.X402, x402ResourcesUrl: 'https://a/x402.json' }),
		).toBeNull();
		expect(getRegistryEndpointError({ type: RegistryEntryType.X402 })).toBe('X402 agents require x402ResourcesUrl');
	});

	it('forbids an endpoint field that belongs to another type', () => {
		expect(
			getRegistryEndpointError({
				type: RegistryEntryType.OpenApi,
				openApiSpecUrl: 'https://a/oapi.json',
				apiBaseUrl: 'https://a.example',
			}),
		).toBe('apiBaseUrl is not valid for a OpenApi agent; use openApiSpecUrl');

		expect(
			getRegistryEndpointError({
				type: RegistryEntryType.Standard,
				apiBaseUrl: 'https://a.example',
				x402ResourcesUrl: 'https://a/x402.json',
			}),
		).toBe('x402ResourcesUrl is not valid for a Standard agent; use apiBaseUrl');
	});
});
