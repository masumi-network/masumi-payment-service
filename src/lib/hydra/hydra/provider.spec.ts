import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { Protocol, UTxO } from '@meshsdk/core';
import { POLICY_ID_LENGTH } from '@meshsdk/core';

import { HydraTransportAmbiguousError } from './errors';
import type { IHydraNode } from './node';
import { HydraProvider } from './provider';
import { HydraHeadStatus } from '@/generated/prisma/client';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const validPolicyId = 'a'.repeat(POLICY_ID_LENGTH);
const shortPolicyId = 'a'.repeat(POLICY_ID_LENGTH - 1);

const snapshotUtxos: UTxO[] = [
	{
		input: { txHash: 'tx001', outputIndex: 0 },
		output: {
			address: 'addr_test1alice',
			amount: [
				{ unit: 'lovelace', quantity: '5000000' },
				{ unit: `${validPolicyId}token`, quantity: '10' },
			],
		},
	},
	{
		input: { txHash: 'tx001', outputIndex: 1 },
		output: {
			address: 'addr_test1bob',
			amount: [{ unit: 'lovelace', quantity: '2000000' }],
		},
	},
	{
		input: { txHash: 'tx002', outputIndex: 0 },
		output: {
			address: 'addr_test1alice',
			amount: [{ unit: 'lovelace', quantity: '1000000' }],
		},
	},
];

const mockProtocol = { minFeeA: 44 } as unknown as Protocol;

// ---------------------------------------------------------------------------
// Node mock factory
// ---------------------------------------------------------------------------

function makeNodeMock(): jest.Mocked<IHydraNode> {
	const mock = {
		connect: jest.fn<() => void>().mockReturnValue(undefined),
		init: jest.fn<() => Promise<unknown>>().mockResolvedValue(undefined),
		commit: jest.fn<() => Promise<unknown>>().mockResolvedValue({}),
		cardanoTransaction: jest.fn<() => Promise<unknown>>().mockResolvedValue({}),
		snapshotUTxO: jest.fn<() => Promise<UTxO[]>>().mockResolvedValue(snapshotUtxos),
		fetchProtocolParameters: jest.fn<() => Promise<Protocol>>().mockResolvedValue(mockProtocol),
		newTx: jest.fn<() => Promise<string>>().mockResolvedValue('confirmedTxHash'),
		isTxConfirmed: jest.fn<(txHash: string) => boolean>().mockReturnValue(false),
		awaitTx: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
		close: jest.fn<() => Promise<unknown>>().mockResolvedValue(undefined),
		fanout: jest.fn<() => Promise<unknown>>().mockResolvedValue(undefined),
		get: jest.fn<() => Promise<unknown>>().mockResolvedValue({}),
		post: jest.fn<() => Promise<unknown>>().mockResolvedValue({}),
		status: HydraHeadStatus.Open,
		httpUrl: 'http://localhost:4001',
		wsUrl: 'ws://localhost:4001',
		headClock: undefined,
	};
	return mock as unknown as jest.Mocked<IHydraNode>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HydraProvider', () => {
	let node: jest.Mocked<IHydraNode>;
	let provider: HydraProvider;

	beforeEach(() => {
		node = makeNodeMock();
		provider = new HydraProvider({ node });
	});

	// -------------------------------------------------------------------------
	// Constructor
	// -------------------------------------------------------------------------

	describe('constructor', () => {
		it('calls node.connect on instantiation', () => {
			expect(node.connect).toHaveBeenCalledTimes(1);
		});
	});

	// -------------------------------------------------------------------------
	// fetchUTxOs
	// -------------------------------------------------------------------------

	describe('fetchUTxOs', () => {
		it('returns all UTxOs when called with no arguments', async () => {
			const result = await provider.fetchUTxOs();
			expect(result).toEqual(snapshotUtxos);
		});

		it('filters by txHash when hash is provided', async () => {
			const result = await provider.fetchUTxOs('tx001');
			expect(result).toHaveLength(2);
			expect(result.every((u) => u.input.txHash === 'tx001')).toBe(true);
		});

		it('filters by txHash and outputIndex when both are provided', async () => {
			const result = await provider.fetchUTxOs('tx001', 1);
			expect(result).toHaveLength(1);
			expect(result[0].input.outputIndex).toBe(1);
		});

		it('filters output index zero instead of treating it as absent', async () => {
			const result = await provider.fetchUTxOs('tx001', 0);
			expect(result).toHaveLength(1);
			expect(result[0].input.outputIndex).toBe(0);
		});

		it('returns empty array when hash matches nothing', async () => {
			const result = await provider.fetchUTxOs('nonexistent');
			expect(result).toHaveLength(0);
		});

		it('delegates to node.snapshotUTxO', async () => {
			await provider.fetchUTxOs();
			expect(node.snapshotUTxO).toHaveBeenCalledTimes(1);
		});
	});

	// -------------------------------------------------------------------------
	// fetchAddressUTxOs
	// -------------------------------------------------------------------------

	describe('fetchAddressUTxOs', () => {
		it('returns all UTxOs for a given address', async () => {
			const result = await provider.fetchAddressUTxOs('addr_test1alice');
			expect(result).toHaveLength(2);
			expect(result.every((u) => u.output.address === 'addr_test1alice')).toBe(true);
		});

		it('returns empty array for an address with no UTxOs', async () => {
			const result = await provider.fetchAddressUTxOs('addr_test1unknown');
			expect(result).toHaveLength(0);
		});

		it('filters by asset when the asset argument is provided', async () => {
			const asset = `${validPolicyId}token`;
			const result = await provider.fetchAddressUTxOs('addr_test1alice', asset);
			expect(result).toHaveLength(1);
			expect(result[0].output.amount.some((a) => a.unit === asset)).toBe(true);
		});

		it('returns empty array when address matches but asset does not', async () => {
			const result = await provider.fetchAddressUTxOs('addr_test1alice', 'nonexistentasset');
			expect(result).toHaveLength(0);
		});
	});

	// -------------------------------------------------------------------------
	// fetchProtocolParameters
	// -------------------------------------------------------------------------

	describe('fetchProtocolParameters', () => {
		it('delegates to node.fetchProtocolParameters', async () => {
			const result = await provider.fetchProtocolParameters();
			expect(node.fetchProtocolParameters).toHaveBeenCalledTimes(1);
			expect(result).toBe(mockProtocol);
		});
	});

	// -------------------------------------------------------------------------
	// fetchCostModels
	// -------------------------------------------------------------------------

	describe('fetchCostModels', () => {
		it('returns an empty array regardless of epoch', async () => {
			await expect(provider.fetchCostModels()).resolves.toEqual([]);
			await expect(provider.fetchCostModels(400)).resolves.toEqual([]);
		});
	});

	// -------------------------------------------------------------------------
	// fetchAssetAddresses
	// -------------------------------------------------------------------------

	describe('fetchAssetAddresses', () => {
		it('returns addresses holding the asset with their quantities', async () => {
			const asset = `${validPolicyId}token`;
			const result = await provider.fetchAssetAddresses(asset);
			expect(result).toHaveLength(1);
			expect(result[0].address).toBe('addr_test1alice');
			expect(result[0].quantity).toBe('10');
		});

		it('throws when no address holds the requested asset', async () => {
			await expect(provider.fetchAssetAddresses('unknownasset')).rejects.toThrow(
				'No address found holding asset: unknownasset',
			);
		});
	});

	// -------------------------------------------------------------------------
	// fetchCollectionAssets
	// -------------------------------------------------------------------------

	describe('fetchCollectionAssets', () => {
		it('returns all assets matching a valid policyId', async () => {
			const result = await provider.fetchCollectionAssets(validPolicyId);
			expect(result.assets).toHaveLength(1);
			expect(result.assets[0].unit).toBe(`${validPolicyId}token`);
			expect(result.assets[0].quantity).toBe('10');
		});

		it('throws when policyId length is not 56 characters', async () => {
			await expect(provider.fetchCollectionAssets(shortPolicyId)).rejects.toThrow(
				'Invalid policyId length: must be a 56-character hexadecimal string',
			);
		});

		it('throws when no assets match the policyId', async () => {
			const otherPolicyId = 'b'.repeat(POLICY_ID_LENGTH);
			await expect(provider.fetchCollectionAssets(otherPolicyId)).rejects.toThrow(
				`No assets found in the head snapshot: ${otherPolicyId}`,
			);
		});
	});

	// -------------------------------------------------------------------------
	// submitTx
	// -------------------------------------------------------------------------

	describe('submitTx', () => {
		it('calls node.newTx with a HydraTransaction wrapping the cborHex', async () => {
			const cborHex = 'deadbeef';
			const result = await provider.submitTx(cborHex);
			expect(node.newTx).toHaveBeenCalledTimes(1);
			const txArg = node.newTx.mock.calls[0][0];
			expect(txArg.cborHex).toBe(cborHex);
			expect(txArg.description).toBe('');
			expect(result).toBe('confirmedTxHash');
		});

		it('revokes an already-captured provider before it can queue transaction bytes', async () => {
			const isSubmissionAllowed = jest.fn(() => false);
			provider = new HydraProvider({ node, isSubmissionAllowed });

			await expect(provider.submitTx('deadbeef')).rejects.toThrow(
				'Hydra provider is no longer admitted for transaction submission',
			);
			expect(isSubmissionAllowed).toHaveBeenCalledTimes(1);
			expect(node.newTx).not.toHaveBeenCalled();
		});

		/**
		 * `TxValid` is one node's local ledger saying yes. It is not the head's
		 * answer: a peer can refuse the same body (seen live 2026-09-07 — node 2's
		 * clock sat 44 slots behind node 1's, so the window's `invalidBefore` was
		 * in node 2's future and it answered OutsideValidityIntervalUTxO) and then
		 * no snapshot is ever proposed. Nothing tells the submitter. The tx just
		 * never appears, while the service has already advanced its DB on the
		 * `TxValid` and left the request pointing at a tx no node holds.
		 *
		 * So `submitTx` does not return until the tx is in a confirmed snapshot —
		 * the head's answer, not one node's — and a confirmation timeout is the
		 * transport-ambiguous error, which the reservation layer already holds
		 * for reconciliation instead of finalizing.
		 */
		it('does not resolve on TxValid alone: waits for the tx to reach a confirmed snapshot', async () => {
			await provider.submitTx('deadbeef');
			expect(node.awaitTx).toHaveBeenCalledTimes(1);
			expect(node.awaitTx).toHaveBeenCalledWith('confirmedTxHash');
			// Confirmation is awaited after submission, never before it.
			const newTxOrder = node.newTx.mock.invocationCallOrder[0];
			const awaitTxOrder = node.awaitTx.mock.invocationCallOrder[0];
			expect(awaitTxOrder).toBeGreaterThan(newTxOrder);
		});

		it('surfaces a confirmation timeout as transport-ambiguous rather than success', async () => {
			node.awaitTx.mockRejectedValueOnce(
				new HydraTransportAmbiguousError('Hydra transaction confirmedTxHash was not confirmed within 30000ms'),
			);
			await expect(provider.submitTx('deadbeef')).rejects.toThrow(HydraTransportAmbiguousError);
			// The bytes were handed over; this must never read as "not dispatched".
			expect(node.newTx).toHaveBeenCalledTimes(1);
		});
	});

	// -------------------------------------------------------------------------
	// get (passthrough)
	// -------------------------------------------------------------------------

	describe('get', () => {
		it('delegates to node.get and returns its response', async () => {
			const mockResponse = { data: 42 };
			node.get.mockResolvedValueOnce(mockResponse);
			const result = await provider.get('/some/url');
			expect(node.get).toHaveBeenCalledWith('/some/url');
			expect(result).toBe(mockResponse);
		});
	});

	// -------------------------------------------------------------------------
	// Unsupported methods
	// -------------------------------------------------------------------------

	describe('unsupported methods', () => {
		const errorMessage = 'Not supported in Hydra L2.';

		it('fetchAccountInfo throws', async () => {
			await expect(provider.fetchAccountInfo()).rejects.toThrow(errorMessage);
		});

		it('fetchAddressTxs throws', async () => {
			await expect(provider.fetchAddressTxs()).rejects.toThrow(errorMessage);
		});

		it('fetchAssetMetadata throws', async () => {
			await expect(provider.fetchAssetMetadata()).rejects.toThrow(errorMessage);
		});

		it('fetchBlockInfo throws', async () => {
			await expect(provider.fetchBlockInfo()).rejects.toThrow(errorMessage);
		});

		it('fetchGovernanceProposal throws', async () => {
			await expect(provider.fetchGovernanceProposal()).rejects.toThrow(errorMessage);
		});

		it('fetchTxInfo throws', async () => {
			await expect(provider.fetchTxInfo('somehash')).rejects.toThrow(errorMessage);
		});
	});

	// -------------------------------------------------------------------------
	// getHeadClock
	// -------------------------------------------------------------------------

	describe('getHeadClock', () => {
		it('returns the node headClock', () => {
			const clock = { chainTimeMs: 1751959157000, chainSlot: 127811957, receivedAtMs: Date.now() };
			const clockNode = { ...makeNodeMock(), headClock: clock } as unknown as jest.Mocked<IHydraNode>;
			const clockProvider = new HydraProvider({ node: clockNode });
			expect(clockProvider.getHeadClock()).toEqual(clock);
		});

		it('returns undefined when the node has seen no clock message', () => {
			expect(provider.getHeadClock()).toBeUndefined();
		});
	});
});
