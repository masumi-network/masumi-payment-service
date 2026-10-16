import { describe, expect, it } from '@jest/globals';
import {
	isPersistedHydraOutput,
	isTransactionBoundToHydraLineage,
	type HydraRequestLineage,
} from './hydra-request-lineage';

const lineage: HydraRequestLineage = {
	currentHydraUtxoTxHash: 'escrow-tx',
	currentHydraUtxoOutputIndex: 1,
	CurrentTransaction: { txHash: 'escrow-tx', intendedTxHash: null, hydraHeadId: 'head-1' },
	TransactionHistory: [{ txHash: 'old-tx' }],
};

const bound = (txId: string, consumedInputs: Array<{ txHash: string; outputIndex: number }> | null) =>
	isTransactionBoundToHydraLineage(lineage, { hydraHeadId: 'head-1', txId, consumedInputs });

describe('isTransactionBoundToHydraLineage', () => {
	it('binds a tx that consumes the persisted escrow output', () => {
		expect(bound('spend-tx', [{ txHash: 'escrow-tx', outputIndex: 1 }])).toBe(true);
	});

	it('binds the current transaction by hash or intended hash on the same head', () => {
		expect(bound('escrow-tx', [])).toBe(true);
		expect(
			isTransactionBoundToHydraLineage(
				{ ...lineage, CurrentTransaction: { txHash: null, intendedTxHash: 'pending-tx', hydraHeadId: 'head-1' } },
				{ hydraHeadId: 'head-1', txId: 'pending-tx', consumedInputs: [] },
			),
		).toBe(true);
	});

	it('binds a tx the escrow already recorded in its history', () => {
		expect(bound('old-tx', [])).toBe(true);
	});

	it('does not bind a peer tx that leaves the escrow output unspent', () => {
		expect(bound('peer-tx', [{ txHash: 'escrow-tx', outputIndex: 0 }])).toBe(false);
		expect(bound('peer-tx', [{ txHash: 'peer-funds', outputIndex: 1 }])).toBe(false);
	});

	it('does not bind the current transaction hash seen on another head', () => {
		expect(
			isTransactionBoundToHydraLineage(lineage, { hydraHeadId: 'head-2', txId: 'escrow-tx', consumedInputs: [] }),
		).toBe(false);
	});

	it('cannot rule out binding without decoded inputs', () => {
		expect(bound('peer-tx', null)).toBe(true);
	});
});

describe('isPersistedHydraOutput', () => {
	it('matches only the exact accepted output reference', () => {
		expect(isPersistedHydraOutput(lineage, { txHash: 'escrow-tx', outputIndex: 1 })).toBe(true);
		expect(isPersistedHydraOutput(lineage, { txHash: 'escrow-tx', outputIndex: 0 })).toBe(false);
		expect(isPersistedHydraOutput(lineage, { txHash: 'peer-tx', outputIndex: 1 })).toBe(false);
	});
});
