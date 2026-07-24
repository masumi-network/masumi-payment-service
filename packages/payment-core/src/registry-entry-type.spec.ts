import { RegistryEntryType } from '@prisma/client';
import { REGISTRY_ENTRY_ON_CHAIN_TYPE, registryEntryTypeFromOnChain } from './registry-entry-type';

describe('registry entry type on-chain mapping', () => {
	it('Standard emits no on-chain type (byte-identical to pre-feature mints)', () => {
		expect(REGISTRY_ENTRY_ON_CHAIN_TYPE[RegistryEntryType.Standard]).toBeUndefined();
	});

	it('maps OpenApi/X402 to their versioned on-chain strings', () => {
		expect(REGISTRY_ENTRY_ON_CHAIN_TYPE[RegistryEntryType.OpenApi]).toBe('OpenAPI');
		expect(REGISTRY_ENTRY_ON_CHAIN_TYPE[RegistryEntryType.X402]).toBe('x402V1');
	});

	it('round-trips every enum value through the on-chain form', () => {
		for (const entryType of Object.values(RegistryEntryType)) {
			const onChain = REGISTRY_ENTRY_ON_CHAIN_TYPE[entryType];
			expect(registryEntryTypeFromOnChain(onChain)).toBe(entryType);
		}
	});

	it('resolves absent or unknown on-chain type to Standard', () => {
		expect(registryEntryTypeFromOnChain(undefined)).toBe(RegistryEntryType.Standard);
		expect(registryEntryTypeFromOnChain('SomeFutureType')).toBe(RegistryEntryType.Standard);
	});

	it('accepts a chunked (array) on-chain type value', () => {
		expect(registryEntryTypeFromOnChain(['Open', 'API'])).toBe(RegistryEntryType.OpenApi);
	});
});
