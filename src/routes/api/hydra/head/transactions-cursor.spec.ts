/**
 * The merged head history pages without skipping or repeating a row.
 *
 * It reads three tables, and a Prisma cursor walks only one. Paging it the
 * naive way skips rows from two sources and repeats rows from the third. These
 * tests walk every page against an in-memory copy of the three tables, with
 * rows from different tables written in the same millisecond, and check that
 * the walk sees every row exactly once and in order.
 */

import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { TransactionLayer, TransactionStatus } from '@/generated/prisma/client';

type Row = { id: string; createdAt: Date; hydraHeadId?: string; toAddress?: string };
type Where = Record<string, unknown> & { OR?: Array<Record<string, unknown>> };

const NODE_ADDRESS = 'addr_test_node';
const HEAD_ID = 'head-1';

const tables: Record<'transaction' | 'hydraTopup' | 'walletFundTransfer', Row[]> = {
	transaction: [],
	hydraTopup: [],
	walletFundTransfer: [],
};

function matchesClause(row: Row, clause: Record<string, unknown>): boolean {
	return Object.entries(clause).every(([key, condition]) => {
		const value = row[key as keyof Row];
		if (condition !== null && typeof condition === 'object' && !(condition instanceof Date)) {
			const { lt, lte } = condition as { lt?: Date | string; lte?: Date | string };
			if (lt !== undefined) return (value as Date | string) < lt;
			if (lte !== undefined) return (value as Date | string) <= lte;
		}
		return condition instanceof Date ? (value as Date).getTime() === condition.getTime() : value === condition;
	});
}

function matches(row: Row, where: Where): boolean {
	const { OR, ...rest } = where;
	return matchesClause(row, rest) && (OR === undefined || OR.some((clause) => matchesClause(row, clause)));
}

function newestFirst(left: Row, right: Row): number {
	const byTime = right.createdAt.getTime() - left.createdAt.getTime();
	return byTime !== 0 ? byTime : left.id < right.id ? 1 : -1;
}

function fakeTable(name: keyof typeof tables) {
	return {
		findMany: jest.fn(async ({ where, take }: { where: Where; take: number }) =>
			tables[name]
				.filter((row) => matches(row, where))
				.sort(newestFirst)
				.slice(0, take)
				.map((row) => ({
					...row,
					txHash: null,
					intendedTxHash: null,
					depositTxHash: null,
					splitTxHash: null,
					status: name === 'hydraTopup' ? 'Pending' : TransactionStatus.Confirmed,
					layer: TransactionLayer.L2,
					confirmations: null,
					fees: null,
					blockTime: null,
					lastCheckedAt: null,
					committedLovelace: 0n,
					lovelaceAmount: 1n,
				})),
		),
		findFirst: jest.fn(async ({ where }: { where: Where }) => {
			const row = tables[name].find((candidate) => matches(candidate, where));
			return row ? { id: row.id, createdAt: row.createdAt } : null;
		}),
	};
}

jest.unstable_mockModule('@masumi/payment-core/auth', () => ({
	adminAuthenticatedEndpointFactory: { build: (definition: unknown) => definition },
}));

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		hydraHead: {
			findUnique: jest.fn(async () => ({
				id: HEAD_ID,
				HydraRelation: { network: 'Preprod' },
				LocalParticipant: { cardanoVkey: 'vkey' },
			})),
		},
		transaction: fakeTable('transaction'),
		hydraTopup: fakeTable('hydraTopup'),
		walletFundTransfer: fakeTable('walletFundTransfer'),
	},
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('@/services/hydra-node-funding/node-address', () => ({
	nodeCardanoAddress: () => NODE_ADDRESS,
}));

type ListOutput = { transactions: Array<{ id: string; kind: string }> };
let listHeadTransactionsGet: { handler: (args: { input: unknown }) => Promise<ListOutput> };

beforeAll(async () => {
	({ listHeadTransactionsGet } = (await import('./transactions')) as never);
});

/** Pages the way the admin UI does: inclusive cursor, dedupe by id, stop on a short page. */
async function walkAllPages(limit: number): Promise<string[]> {
	const seen: string[] = [];
	let cursorId: string | undefined;
	for (let guard = 0; guard < 100; guard += 1) {
		const { transactions } = await listHeadTransactionsGet.handler({
			input: { headId: HEAD_ID, limit, cursorId },
		});
		for (const row of transactions) {
			if (!seen.includes(row.id)) seen.push(row.id);
		}
		if (transactions.length < limit) return seen;
		cursorId = transactions[transactions.length - 1].id;
	}
	throw new Error('paging did not terminate');
}

const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 12, minute));

beforeEach(() => {
	// Rows from all three tables interleave in time, and several share a
	// timestamp across tables, which is where a time-only cursor goes wrong.
	tables.transaction = [
		{ id: 'tx-a', createdAt: at(10), hydraHeadId: HEAD_ID },
		{ id: 'tx-b', createdAt: at(8), hydraHeadId: HEAD_ID },
		{ id: 'tx-c', createdAt: at(8), hydraHeadId: HEAD_ID },
		{ id: 'tx-d', createdAt: at(3), hydraHeadId: HEAD_ID },
		{ id: 'tx-other-head', createdAt: at(9), hydraHeadId: 'head-2' },
	];
	tables.hydraTopup = [
		{ id: 'dep-a', createdAt: at(9), hydraHeadId: HEAD_ID },
		{ id: 'dep-b', createdAt: at(8), hydraHeadId: HEAD_ID },
		{ id: 'dep-c', createdAt: at(1), hydraHeadId: HEAD_ID },
	];
	tables.walletFundTransfer = [
		{ id: 'fund-a', createdAt: at(8), toAddress: NODE_ADDRESS },
		{ id: 'fund-b', createdAt: at(5), toAddress: NODE_ADDRESS },
		{ id: 'fund-other', createdAt: at(7), toAddress: 'addr_test_someone_else' },
	];
});

const EXPECTED_ORDER = ['tx-a', 'dep-a', 'tx-c', 'tx-b', 'fund-a', 'dep-b', 'fund-b', 'tx-d', 'dep-c'];

describe('head transactions cursor', () => {
	it('returns the newest rows across all three sources on the first page', async () => {
		const { transactions } = await listHeadTransactionsGet.handler({ input: { headId: HEAD_ID, limit: 4 } });
		expect(transactions.map((row) => row.id)).toEqual(EXPECTED_ORDER.slice(0, 4));
	});

	// From 2: an inclusive cursor cannot advance on pages of 1, since the
	// only row returned is the cursor itself. That holds for every list here.
	for (const limit of [2, 3, 4, 5, 9, 25]) {
		it(`walks every row once, in order, with pages of ${limit}`, async () => {
			expect(await walkAllPages(limit)).toEqual(EXPECTED_ORDER);
		});
	}

	it('repeats the cursor row first, like every other list', async () => {
		const { transactions } = await listHeadTransactionsGet.handler({
			input: { headId: HEAD_ID, limit: 3, cursorId: 'fund-a' },
		});
		expect(transactions.map((row) => row.id)).toEqual(['fund-a', 'dep-b', 'fund-b']);
	});

	it('returns an empty page for a cursor this head does not list', async () => {
		for (const cursorId of ['tx-other-head', 'fund-other', 'missing']) {
			const { transactions } = await listHeadTransactionsGet.handler({
				input: { headId: HEAD_ID, limit: 3, cursorId },
			});
			expect(transactions).toEqual([]);
		}
	});
});
