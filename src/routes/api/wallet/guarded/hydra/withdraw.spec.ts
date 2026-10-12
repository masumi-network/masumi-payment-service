import { describe, expect, it, jest } from '@jest/globals';
import type { UTxO } from '@meshsdk/core';

jest.unstable_mockModule('@masumi/payment-core/db', () => ({ prisma: {} }));
jest.unstable_mockModule('@/services/hydra-connection-manager/hydra-connection-manager.service', () => ({
	getHydraConnectionManager: () => ({}),
}));

const { pickAgentCollateral } = await import('./withdraw');

const AGENT = 'addr_test1agent';
function utxo(id: number, address: string, amount: UTxO['output']['amount'], plutusData?: string): UTxO {
	return {
		input: { txHash: String(id).repeat(64).slice(0, 64), outputIndex: 0 },
		output: { address, amount, plutusData },
	};
}
const ada = (lovelace: number) => [{ unit: 'lovelace', quantity: String(lovelace) }];

describe('pickAgentCollateral', () => {
	it('picks the smallest plain ADA-only agent UTxO of at least 5 ADA', () => {
		const picked = pickAgentCollateral(
			[utxo(1, AGENT, ada(20_000_000)), utxo(2, AGENT, ada(6_000_000)), utxo(3, AGENT, ada(4_000_000))],
			AGENT,
		);
		expect(picked?.input.txHash).toBe('2'.repeat(64));
	});

	it('skips other addresses, datum outputs and token bundles', () => {
		const snapshot = [
			utxo(1, 'addr_test1other', ada(10_000_000)),
			utxo(2, AGENT, ada(10_000_000), 'd87980'),
			utxo(3, AGENT, [...ada(10_000_000), { unit: 'ff'.repeat(28), quantity: '1' }]),
		];
		expect(pickAgentCollateral(snapshot, AGENT)).toBeNull();
	});
});
