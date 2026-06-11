import { describe, it, expect, jest } from '@jest/globals';
import { createL2Providers } from './create-l2-providers';
import type { HydraProvider } from '@/lib/hydra';
import type { HydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';

function makeManagerMock(provider: HydraProvider | null): HydraConnectionManager {
	return {
		getProvider: jest.fn<() => HydraProvider | null>().mockReturnValue(provider),
	} as unknown as HydraConnectionManager;
}

describe('createL2Providers', () => {
	it('returns HydraContext with provider and headId when provider exists', () => {
		const fakeProvider = {} as HydraProvider;
		const manager = makeManagerMock(fakeProvider);
		const result = createL2Providers('head-abc', manager);
		expect(result.hydraProvider).toBe(fakeProvider);
		expect(result.hydraHeadId).toBe('head-abc');
	});

	it('throws when no provider is found for the given headId', () => {
		const manager = makeManagerMock(null);
		expect(() => createL2Providers('head-xyz', manager)).toThrow(
			'No active HydraProvider for head head-xyz. Is the head connected and open?',
		);
	});

	it('calls connectionManager.getProvider with the correct headId', () => {
		const fakeProvider = {} as HydraProvider;
		const manager = makeManagerMock(fakeProvider);
		createL2Providers('head-001', manager);
		expect(manager.getProvider).toHaveBeenCalledWith('head-001');
	});
});
