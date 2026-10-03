import { describe, expect, it, jest } from '@jest/globals';

type AnyMock = jest.Mock<(...args: any[]) => any>;

const mockFindUnique = jest.fn() as AnyMock;
const mockFetchHealth = jest.fn() as AnyMock;

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: { hydraLocalParticipant: { findUnique: mockFindUnique } },
}));
jest.unstable_mockModule('@/services/hydra-host/client', () => ({ fetchHostNodeHealth: mockFetchHealth }));
jest.unstable_mockModule('@/utils/security/encryption', () => ({ decrypt: () => 'token' }));

const { readParticipantNodeState } = await import('./node-state');

const PARTICIPANT = { id: 'p1', hostNodeId: 'n1', HydraHost: { baseUrl: 'http://host', encryptedUserToken: 'x' } };

async function stateFor(health: Record<string, unknown>) {
	mockFindUnique.mockResolvedValue(PARTICIPANT);
	mockFetchHealth.mockResolvedValue(health);
	return await readParticipantNodeState('p1');
}

describe('readParticipantNodeState', () => {
	it('is ready when the node is usable', async () => {
		const state = await stateFor({ usable: true, state: 'Running', chainSynced: true, driftSeconds: 0 });

		expect(state.isReady).toBe(true);
		expect(state.reason).toBeNull();
	});

	/**
	 * The message this exists for.
	 *
	 * "Still catching up" reads the same at thirty seconds behind and at fifteen
	 * hours, and those call for opposite responses. A head whose node has been
	 * offline longer than its unsynced period refuses everything — L2 included —
	 * so the size of the gap is the whole decision.
	 */
	it('says how far behind the node is', async () => {
		const state = await stateFor({
			usable: false,
			state: 'Running',
			chainSynced: false,
			driftSeconds: 54_600,
		});

		expect(state.isReady).toBe(false);
		expect(state.reason).toContain('15.2 hours behind');
	});

	it.each([
		[30, '30 seconds'],
		[600, '10 minutes'],
		[54_600, '15.2 hours'],
		[400_000, '4.6 days'],
	])('reports %s seconds as %s', async (driftSeconds, expected) => {
		const state = await stateFor({ usable: false, state: 'Running', chainSynced: false, driftSeconds });

		expect(state.reason).toContain(expected);
	});

	// An older Host does not report the magnitude; the message still has to work.
	it('omits the distance when the host does not report one', async () => {
		const state = await stateFor({ usable: false, state: 'Running', chainSynced: false, driftSeconds: null });

		expect(state.reason).toContain('still catching up');
		expect(state.reason).not.toContain('behind');
	});

	it('reports a node that is not running at all', async () => {
		const state = await stateFor({ usable: false, state: 'Stopped', chainSynced: false, driftSeconds: null });

		expect(state.reason).toContain('not running');
	});
});
