import { resolveTransactionAgentName } from './resolve-transaction-agent-name';

// Minimal fake matching the `registryRequest.findFirst` surface the resolver uses.
function fakeDb(registryName: string | null) {
	return {
		registryRequest: {
			findFirst: jest.fn().mockResolvedValue(registryName === null ? null : { name: registryName }),
		},
	} as never;
}

describe('resolveTransactionAgentName', () => {
	it('prefers on-chain name when preferOnChain is set and it is present', async () => {
		const db = fakeDb('Registry Name');
		const result = await resolveTransactionAgentName({
			agentIdentifier: 'agent-1',
			onChainName: 'On-Chain Name',
			preferOnChain: true,
			db,
		});
		expect(result).toBe('On-Chain Name');
		// Short-circuits without touching the registry.
		expect((db as never as { registryRequest: { findFirst: jest.Mock } }).registryRequest.findFirst).not.toHaveBeenCalled();
	});

	it('falls back to the registry when preferOnChain has no on-chain name', async () => {
		const result = await resolveTransactionAgentName({
			agentIdentifier: 'agent-1',
			onChainName: '   ',
			preferOnChain: true,
			db: fakeDb('Registry Name'),
		});
		expect(result).toBe('Registry Name');
	});

	it('prefers the registry over on-chain when preferOnChain is not set', async () => {
		const result = await resolveTransactionAgentName({
			agentIdentifier: 'agent-1',
			onChainName: 'On-Chain Name',
			db: fakeDb('Registry Name'),
		});
		expect(result).toBe('Registry Name');
	});

	it('falls back to the on-chain name when the registry has no row', async () => {
		const result = await resolveTransactionAgentName({
			agentIdentifier: 'agent-1',
			onChainName: 'On-Chain Name',
			db: fakeDb(null),
		});
		expect(result).toBe('On-Chain Name');
	});

	it('returns null when neither source yields a name', async () => {
		const result = await resolveTransactionAgentName({
			agentIdentifier: 'agent-1',
			onChainName: null,
			db: fakeDb(null),
		});
		expect(result).toBeNull();
	});

	it('normalizes (trims) the resolved name', async () => {
		const result = await resolveTransactionAgentName({
			agentIdentifier: 'agent-1',
			onChainName: '  Spaced Name  ',
			preferOnChain: true,
			db: fakeDb(null),
		});
		expect(result).toBe('Spaced Name');
	});
});
