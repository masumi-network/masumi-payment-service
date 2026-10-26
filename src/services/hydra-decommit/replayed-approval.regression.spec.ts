import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { HydraDecommitStatus } from '@/generated/prisma/client';

type Status = (typeof HydraDecommitStatus)[keyof typeof HydraDecommitStatus];
type Where = {
	AND?: Where[];
	OR?: Where[];
	hydraHeadId?: string;
	decommitTxId?: string;
	status?: Status | { in: Status[] };
	approvedAt?: null | { lte?: Date; gt?: Date };
	l1ObservedAt?: null;
	createdAt?: { lte: Date };
	failureReason?: { in: string[] };
};
type Row = {
	id: string;
	hydraHeadId: string;
	decommitTxId: string;
	status: Status;
	createdAt: Date;
	approvedAt: Date | null;
	l1ObservedAt: Date | null;
	failureReason: string | null;
};

const HEAD = 'a'.repeat(56);
const TX = 'b'.repeat(64);
const APPROVED_AT = new Date('2026-10-22T06:01:00Z');
const FINALIZED_AT = new Date('2026-10-22T06:02:00Z');
const REPLAYED_AT = new Date('2026-10-22T06:10:00Z');
let row: Row;

/** The database boundary enforces the same status and timestamp predicates as PostgreSQL. */
function matches(where: Where): boolean {
	if (where.AND && !where.AND.every(matches)) return false;
	if (where.OR && !where.OR.some(matches)) return false;
	if (where.hydraHeadId !== undefined && where.hydraHeadId !== row.hydraHeadId) return false;
	if (where.decommitTxId !== undefined && where.decommitTxId !== row.decommitTxId) return false;
	if (where.status !== undefined) {
		if (typeof where.status === 'string' ? row.status !== where.status : !where.status.in.includes(row.status)) {
			return false;
		}
	}
	if (where.approvedAt === null && row.approvedAt !== null) return false;
	if (where.l1ObservedAt === null && row.l1ObservedAt !== null) return false;
	if (where.approvedAt) {
		if (row.approvedAt === null) return false;
		if (where.approvedAt.lte && row.approvedAt > where.approvedAt.lte) return false;
		if (where.approvedAt.gt && row.approvedAt <= where.approvedAt.gt) return false;
	}
	if (where.createdAt && row.createdAt > where.createdAt.lte) return false;
	if (where.failureReason && !where.failureReason.in.includes(row.failureReason ?? '')) return false;
	return true;
}

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		hydraDecommit: {
			updateMany: async ({ where, data }: { where: Where; data: Partial<Row> }) => {
				if (!matches(where)) return { count: 0 };
				Object.assign(row, data);
				return { count: 1 };
			},
			findMany: async ({ where }: { where: Where }) => (matches(where) ? [{ ...row }] : []),
			update: async ({ data }: { data: Partial<Row> }) => Object.assign(row, data),
		},
	},
}));
jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.unstable_mockModule('./payout-lookup', () => ({ resolveDecommitPayoutTx: jest.fn() }));

const { readDecommitSettled } = await import('@/lib/hydra/hydra/node-frames');
const { applyDecommitOutcome } = await import('./settle');

async function applyFrame(tag: 'DecommitApproved' | 'DecommitFinalized', timestamp: Date): Promise<boolean> {
	const outcome = readDecommitSettled(tag, {
		tag,
		headId: HEAD,
		...(tag === 'DecommitApproved' ? { decommitTxId: TX } : {}),
		timestamp: timestamp.toISOString(),
	});
	if (!outcome) throw new Error('The fixture frame did not parse');
	return applyDecommitOutcome({ hydraHeadId: HEAD, ...outcome });
}

beforeEach(() => {
	jest.useFakeTimers({ now: REPLAYED_AT });
	row = {
		id: 'withdrawal',
		hydraHeadId: HEAD,
		decommitTxId: TX,
		status: HydraDecommitStatus.Pending,
		createdAt: new Date('2026-10-22T06:00:00Z'),
		approvedAt: null,
		l1ObservedAt: null,
		failureReason: null,
	};
});
afterEach(() => {
	jest.useRealTimers();
});

describe('withdrawal approval and finalization replay', () => {
	it('keeps a replayed node finalization Approved until independent L1 depth', async () => {
		await applyFrame('DecommitApproved', APPROVED_AT);
		expect(await applyFrame('DecommitFinalized', FINALIZED_AT)).toBe(true);
		expect(row.status).toBe(HydraDecommitStatus.Approved);
		expect(row.l1ObservedAt).toEqual(FINALIZED_AT);
		expect(row.approvedAt).toEqual(APPROVED_AT);
	});

	it('does not attribute an earlier anonymous finalization to a later approved withdrawal', async () => {
		await applyFrame('DecommitApproved', APPROVED_AT);
		expect(await applyFrame('DecommitFinalized', new Date('2026-10-22T06:00:30Z'))).toBe(false);
		expect(row.status).toBe(HydraDecommitStatus.Approved);
	});

	it('repairs a replay-time approval already stored before this fix', async () => {
		row.status = HydraDecommitStatus.Approved;
		row.approvedAt = REPLAYED_AT;
		await applyFrame('DecommitApproved', APPROVED_AT);
		expect(await applyFrame('DecommitFinalized', FINALIZED_AT)).toBe(true);
		expect(row.approvedAt).toEqual(APPROVED_AT);
	});

	it('fills an unknown approval time before attributing an anonymous historical finalization', async () => {
		row.status = HydraDecommitStatus.Approved;
		await applyFrame('DecommitApproved', APPROVED_AT);
		expect(await applyFrame('DecommitFinalized', new Date('2026-10-22T06:00:30Z'))).toBe(false);
		expect(row.status).toBe(HydraDecommitStatus.Approved);
		expect(row.approvedAt).toEqual(APPROVED_AT);
	});

	it.each([undefined, 'invalid date', 42])('keeps the existing approval-time fallback for %j', async (timestamp) => {
		const outcome = readDecommitSettled('DecommitApproved', {
			tag: 'DecommitApproved',
			headId: HEAD,
			decommitTxId: TX,
			timestamp,
		});
		if (!outcome) throw new Error('The fixture frame did not parse');
		await applyDecommitOutcome({ hydraHeadId: HEAD, ...outcome });
		expect(row.approvedAt).toEqual(REPLAYED_AT);
	});

	it.each([HydraDecommitStatus.Finalized, HydraDecommitStatus.Failed])(
		'keeps a terminal %s withdrawal unchanged on an old approval',
		async (status) => {
			row.status = status;
			row.failureReason = status === HydraDecommitStatus.Failed ? 'the head refused the withdrawal' : null;
			row.approvedAt = REPLAYED_AT;
			expect(await applyFrame('DecommitApproved', APPROVED_AT)).toBe(false);
			expect(row.status).toBe(status);
			expect(row.approvedAt).toEqual(REPLAYED_AT);
		},
	);
});
