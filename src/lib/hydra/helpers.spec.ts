import { describe, it, expect } from '@jest/globals';
import { extractNetworkFromProjectId } from './helpers';

describe('extractNetworkFromProjectId', () => {
	it('extracts preprod from a preprod project ID', () => {
		expect(extractNetworkFromProjectId('preprodAbcDefGhi')).toBe('preprod');
	});

	it('extracts mainnet from a mainnet project ID', () => {
		expect(extractNetworkFromProjectId('mainnetXyzUvwQrs')).toBe('mainnet');
	});

	it('extracts preview from a preview project ID', () => {
		expect(extractNetworkFromProjectId('previewAbcDef123')).toBe('preview');
	});

	it('throws for unknown prefix', () => {
		expect(() => extractNetworkFromProjectId('unknownProject')).toThrow('Unknown network: unknown');
	});

	it('throws for empty string', () => {
		expect(() => extractNetworkFromProjectId('')).toThrow();
	});
});
