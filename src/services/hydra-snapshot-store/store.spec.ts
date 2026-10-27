import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { HydraSnapshotVerificationFrame } from '@/lib/hydra/hydra/snapshot-verification';
import { HydraTransactionType } from '@/lib/hydra/hydra/types';

type AnyMock = jest.Mock<(...args: any[]) => any>;
const mockCreate = jest.fn() as AnyMock;
const mockFindUnique = jest.fn() as AnyMock;
jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: { hydraStoredSnapshot: { create: mockCreate, findUnique: mockFindUnique } },
}));

const { persistVerifiedHydraSnapshot, signedSnapshotJson, signedSnapshotIdentityJson } = await import('./store');

const HEAD_ID = 'ab'.repeat(28);
const output = {
	address: 'addr_test1snapshot',
	value: { lovelace: 2_000_000 },
	referenceScript: null,
	inlineDatum: null,
	inlineDatumRaw: null,
	datum: null,
};
function frame(
	utxo: Record<string, typeof output> = { 'bb#0': output, 'aa#0': output },
): HydraSnapshotVerificationFrame {
	return {
		headId: HEAD_ID,
		signatures: { multiSignature: ['party-a', 'party-b'] },
		snapshot: {
			headId: HEAD_ID,
			version: 0,
			number: 2,
			accumulator: 'signed-accumulator',
			confirmed: [
				{ type: HydraTransactionType.TxConwayEra, txId: 'untrusted-metadata', cborHex: 'deadbeef', description: '' },
			],
			utxo,
			utxoToCommit: null,
			utxoToDecommit: null,
		},
	};
}

beforeEach(() => {
	jest.clearAllMocks();
	mockCreate.mockResolvedValue({});
	mockFindUnique.mockResolvedValue(null);
});

describe('persistVerifiedHydraSnapshot', () => {
	it('stores the signed state with a unique head and snapshot key, excluding unsigned confirmations', async () => {
		await persistVerifiedHydraSnapshot('head-row', frame());
		const data = mockCreate.mock.calls[0]?.[0]?.data;
		expect(data).toEqual(
			expect.objectContaining({
				hydraHeadId: 'head-row',
				headIdentifier: HEAD_ID,
				snapshotNumber: 2n,
				snapshotVersion: 0n,
			}),
		);
		expect(data.signedSnapshotJson).not.toContain('untrusted-metadata');
		expect(data.signedIdentityJson).toBe(signedSnapshotIdentityJson(frame()));
		expect(JSON.parse(data.signedSnapshotJson)).toEqual(
			expect.objectContaining({
				accumulator: 'signed-accumulator',
				signatures: ['party-a', 'party-b'],
			}),
		);
	});

	it('accepts an identical signed commitment with different UTxO references', async () => {
		const first = frame();
		const differentReferences = frame({ 'cc#0': output, 'dd#0': output });
		expect(signedSnapshotJson(first)).not.toBe(signedSnapshotJson(differentReferences));
		expect(signedSnapshotIdentityJson(first)).toBe(signedSnapshotIdentityJson(differentReferences));
		mockFindUnique.mockResolvedValue({
			headIdentifier: HEAD_ID,
			signedIdentityJson: signedSnapshotIdentityJson(first),
		});
		await expect(persistVerifiedHydraSnapshot('head-row', differentReferences)).resolves.toBeUndefined();
		// Every reconnect replays stored snapshots; each must not cost a failed insert.
		expect(mockCreate).not.toHaveBeenCalled();
	});

	it('accepts an identical commitment that another writer stored first', async () => {
		mockFindUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
			headIdentifier: HEAD_ID,
			signedIdentityJson: signedSnapshotIdentityJson(frame()),
		});
		mockCreate.mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }));
		await expect(persistVerifiedHydraSnapshot('head-row', frame())).resolves.toBeUndefined();
	});

	it('rejects conflicting signed state at an existing snapshot number', async () => {
		mockFindUnique.mockResolvedValue({
			headIdentifier: HEAD_ID,
			signedIdentityJson: signedSnapshotIdentityJson(frame()),
		});
		const changed = frame();
		changed.snapshot.accumulator = 'different-accumulator';
		// A protocol error keeps its own message in the recorded replay failure.
		await expect(persistVerifiedHydraSnapshot('head-row', changed)).rejects.toMatchObject({
			name: 'HydraProtocolError',
			message: expect.stringMatching(/contradicted/),
		});
	});

	it('rejects conflicting signed state that another writer stored first', async () => {
		mockFindUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
			headIdentifier: HEAD_ID,
			signedIdentityJson: signedSnapshotIdentityJson(frame()),
		});
		mockCreate.mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }));
		const changed = frame();
		changed.snapshot.accumulator = 'different-accumulator';
		await expect(persistVerifiedHydraSnapshot('head-row', changed)).rejects.toThrow(/contradicted/);
	});

	it('propagates database errors instead of accepting a snapshot without storage', async () => {
		mockCreate.mockRejectedValueOnce(new Error('database unavailable'));
		await expect(persistVerifiedHydraSnapshot('head-row', frame())).rejects.toThrow('database unavailable');
	});
});
