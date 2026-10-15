import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { UTxO } from '@meshsdk/core';
import { logger } from '@masumi/payment-core/logger';
import { Network } from '@/generated/prisma/client';
import {
	L2_RELEASE_NUDGE_INTERVAL_MS,
	nudgeIdleHeadForRelease,
	resetL2ReleaseNudgeThrottle,
	selectReleaseNudgeInput,
	toUtxoRef,
} from './l2-reservation-nudge';

jest.spyOn(logger, 'warn').mockImplementation(() => logger);
jest.spyOn(logger, 'info').mockImplementation(() => logger);

const address = 'addr_test1wallet';
const reservedRefs = [`${'a'.repeat(64)}#0`];

function utxo(txHashChar: string, outputIndex: number, overrides: Partial<UTxO['output']> = {}): UTxO {
	return {
		input: { txHash: txHashChar.repeat(64), outputIndex },
		output: { address, amount: [{ unit: 'lovelace', quantity: '5000000' }], ...overrides },
	};
}

describe('selectReleaseNudgeInput', () => {
	const select = (utxos: UTxO[], options: { pendingIncrementRefs?: Set<string>; verified?: Set<string> } = {}) =>
		selectReleaseNudgeInput({
			utxos,
			address,
			reservedRefs,
			pendingIncrementRefs: options.pendingIncrementRefs ?? new Set(),
			isVerified: (reference) => options.verified?.has(reference) ?? true,
		});

	it('never picks a reserved input, so the input proof stays intact', () => {
		expect(select([utxo('a', 0)])).toBeNull();
	});

	it('picks the lowest plain-ADA reference at the wallet address', () => {
		expect(select([utxo('c', 1), utxo('b', 2)])?.input.txHash).toBe('b'.repeat(64));
	});

	it.each([
		[
			'a token',
			{
				amount: [
					{ unit: 'lovelace', quantity: '2000000' },
					{ unit: 'ab'.repeat(30), quantity: '1' },
				],
			},
		],
		['an inline datum', { plutusData: 'd87980' }],
		['a datum hash', { dataHash: 'ff'.repeat(32) }],
		['a reference script', { scriptRef: '82' }],
		['another address', { address: 'addr_test1other' }],
	] as const)('skips a UTxO with %s', (_label, overrides) => {
		expect(select([utxo('b', 0, overrides as Partial<UTxO['output']>)])).toBeNull();
	});

	it('skips pending increments and anything outside the verified snapshot', () => {
		const pending = utxo('b', 0);
		const unverified = utxo('c', 0);
		expect(
			select([pending, unverified], {
				pendingIncrementRefs: new Set([toUtxoRef(pending)]),
				verified: new Set([toUtxoRef(pending)]),
			}),
		).toBeNull();
	});
});

describe('nudgeIdleHeadForRelease', () => {
	const free = utxo('b', 0);
	const nowMs = 10_000_000;

	beforeEach(() => resetL2ReleaseNudgeThrottle());

	function harness(
		options: {
			wallet?: boolean;
			decommit?: boolean;
			pendingDecommits?: readonly string[];
			recordedCount?: number;
			noHead?: boolean;
		} = {},
	) {
		const database = {
			hotWallet: {
				findFirst: jest.fn(async (_args: unknown) =>
					options.wallet === false
						? null
						: {
								walletAddress: address,
								Secret: { encryptedMnemonic: 'encrypted' },
								PaymentSource: { network: Network.Preprod },
							},
				),
			},
			hydraDecommit: { findFirst: jest.fn(async () => (options.decommit ? { id: 'decommit-1' } : null)) },
			transaction: { updateMany: jest.fn(async (_args: unknown) => ({ count: options.recordedCount ?? 1 })) },
		};
		const node = {
			verifiedSnapshotNumber: 7n as bigint | undefined,
			getVerifiedCurrentOutput: jest.fn((_reference: string, _number: bigint): string | null => 'output-bytes'),
			pendingIncrementUtxoRefs: new Set<string>(),
			fetchPendingDecommitRefs: jest.fn(async () => [...(options.pendingDecommits ?? [])]),
		};
		const provider = {
			fetchAddressUTxOs: jest.fn(async (_address: string) => [utxo('a', 0), free]),
			fetchProtocolParameters: jest.fn(),
		};
		const head = { newTx: jest.fn(async (_transaction: unknown) => 'e'.repeat(64)) };
		const signSelfSend = jest.fn(async (_params: unknown) => 'signed-cbor');
		const run = (candidate: { l2ReleaseNudgeInputRef: string | null } = { l2ReleaseNudgeInputRef: null }, at = nowMs) =>
			nudgeIdleHeadForRelease({
				hydraHeadId: 'head-1',
				candidate: { id: 'reservation-1', l2ReservationInputRefs: reservedRefs, ...candidate },
				node: node as never,
				provider: provider as never,
				head: (options.noHead ? null : head) as never,
				nowMs: at,
				database: database as never,
				signSelfSend,
			});
		return { database, node, provider, head, signSelfSend, run };
	}

	it('records the input on the reservation, then self-sends it', async () => {
		const h = harness();
		await expect(h.run()).resolves.toBe(true);
		expect(h.database.hotWallet.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({ where: { pendingTransactionId: 'reservation-1', deletedAt: null } }),
		);
		expect(h.database.transaction.updateMany).toHaveBeenCalledWith({
			where: { id: 'reservation-1', status: 'Pending', l2ReleaseNudgeInputRef: null },
			data: { l2ReleaseNudgeInputRef: toUtxoRef(free) },
		});
		expect(h.signSelfSend).toHaveBeenCalledWith(expect.objectContaining({ input: free, address }));
		expect(h.head.newTx).toHaveBeenCalledWith(expect.objectContaining({ cborHex: 'signed-cbor' }));
		const recordOrder = h.database.transaction.updateMany.mock.invocationCallOrder[0];
		expect(recordOrder).toBeLessThan(h.head.newTx.mock.invocationCallOrder[0]);
	});

	it('re-sends against the recorded input instead of picking a new one', async () => {
		const h = harness();
		await expect(h.run({ l2ReleaseNudgeInputRef: toUtxoRef(free) })).resolves.toBe(true);
		expect(h.database.transaction.updateMany).not.toHaveBeenCalled();
		expect(h.signSelfSend).toHaveBeenCalledWith(expect.objectContaining({ input: free }));
	});

	it.each([
		['the wallet is not pinned by this reservation', { wallet: false }],
		['a withdrawal is being prepared', { decommit: true }],
		['a decommit is in flight on the node', { pendingDecommits: ['f'.repeat(64)] }],
		['another writer recorded a nudge first', { recordedCount: 0 }],
		['the head session is gone at send time', { noHead: true }],
	] as const)('sends nothing when %s', async (_label, options) => {
		const h = harness(options);
		await expect(h.run()).resolves.toBe(false);
		expect(h.head.newTx).not.toHaveBeenCalled();
	});

	it('swaps in a fresh input once the recorded one is spent, so a lost baseline cannot deadlock', async () => {
		// The first nudge landed, then a restart dropped the in-memory baseline. A
		// fresh baseline sits on the nudge's own snapshot and needs one more.
		const h = harness();
		const spentRef = `${'9'.repeat(64)}#0`;
		h.node.getVerifiedCurrentOutput.mockImplementation((reference) => (reference === spentRef ? null : 'output-bytes'));
		await expect(h.run({ l2ReleaseNudgeInputRef: spentRef })).resolves.toBe(true);
		expect(h.database.transaction.updateMany).toHaveBeenCalledWith({
			where: { id: 'reservation-1', status: 'Pending', l2ReleaseNudgeInputRef: spentRef },
			data: { l2ReleaseNudgeInputRef: toUtxoRef(free) },
		});
		expect(h.signSelfSend).toHaveBeenCalledWith(expect.objectContaining({ input: free }));
	});

	it('nudges a reservation at most once per interval', async () => {
		const h = harness();
		await h.run();
		await expect(h.run(undefined, nowMs + L2_RELEASE_NUDGE_INTERVAL_MS - 1)).resolves.toBe(false);
		await expect(h.run(undefined, nowMs + L2_RELEASE_NUDGE_INTERVAL_MS)).resolves.toBe(true);
		expect(h.head.newTx).toHaveBeenCalledTimes(2);
	});

	it('never throws when the head refuses the nudge', async () => {
		const h = harness();
		h.head.newTx.mockRejectedValue(new Error('TxInvalid'));
		await expect(h.run()).resolves.toBe(false);
	});
});
