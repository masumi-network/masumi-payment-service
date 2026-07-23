import { describe, expect, it } from '@jest/globals';
import {
	buildHydraHttpEndpoint,
	getHydraPlaintextHosts,
	validateHydraHttpUrl,
	validateHydraNodeUrls,
	withHydraHistoryDisabled,
} from './node-url';

describe('validateHydraNodeUrls', () => {
	it.each([
		['http://localhost:4001', 'ws://localhost:4001'],
		['http://127.0.0.42:4001/', 'ws://127.0.0.42:4001/'],
		['http://[::1]:4001', 'ws://[::1]:4001'],
		['https://hydra.example.com', 'wss://hydra.example.com'],
	])('accepts a trusted matching pair', (httpUrl, wsUrl) => {
		expect(validateHydraNodeUrls(httpUrl, wsUrl)).toEqual({
			httpUrl: httpUrl.replace(/\/$/, ''),
			wsUrl: wsUrl.replace(/\/$/, ''),
		});
	});

	it('rejects plaintext remote endpoints by default', () => {
		expect(() => validateHydraNodeUrls('http://10.0.0.8:4001', 'ws://10.0.0.8:4001')).toThrow(
			'must use TLS outside loopback',
		);
	});

	it('allows an exact explicitly trusted plaintext host', () => {
		expect(
			validateHydraNodeUrls('http://hydra-node:4001', 'ws://hydra-node:4001', {
				plaintextHosts: ['hydra-node'],
			}),
		).toEqual({ httpUrl: 'http://hydra-node:4001', wsUrl: 'ws://hydra-node:4001' });
	});

	it.each([
		['different host', 'https://a.example:4001', 'wss://b.example:4001'],
		['different port', 'https://a.example:4001', 'wss://a.example:4002'],
		['mixed security', 'https://a.example', 'ws://a.example:443'],
		['credentials', 'https://user:pass@a.example', 'wss://a.example'],
		['query', 'https://a.example?target=internal', 'wss://a.example'],
	] as const)('rejects %s', (_name, httpUrl, wsUrl) => {
		expect(() => validateHydraNodeUrls(httpUrl, wsUrl, { plaintextHosts: ['a.example'] })).toThrow();
	});
});

describe('Hydra node URL helpers', () => {
	it('safely appends an HTTP endpoint below a base path', () => {
		expect(buildHydraHttpEndpoint('https://hydra.example/proxy', '/protocol-parameters')).toBe(
			'https://hydra.example/proxy/protocol-parameters',
		);
	});

	it('sets history=no without string concatenation', () => {
		expect(withHydraHistoryDisabled('wss://hydra.example/proxy')).toBe('wss://hydra.example/proxy?history=no');
	});

	it('validates standalone HTTP probes', () => {
		expect(validateHydraHttpUrl('https://hydra.example')).toBe('https://hydra.example');
		expect(() => validateHydraHttpUrl('file:///etc/passwd')).toThrow('unsupported protocol');
	});

	it('normalizes the explicit plaintext allowlist', () => {
		expect(getHydraPlaintextHosts(' Hydra-Node,10.0.0.8,hydra-node ')).toEqual(['hydra-node', '10.0.0.8']);
	});
});
