import { beforeEach, describe, expect, it, jest } from '@jest/globals';

type AnyMock = jest.Mock<(...args: any[]) => any>;

const mockRecordHeadError = jest.fn() as AnyMock;

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('@/services/hydra-head-error/record', () => ({
	recordHeadError: mockRecordHeadError,
}));

type HydraHeadStatus = import('@/generated/prisma/client').HydraHeadStatus;

const { EVIDENCE_GAP_RESTART_AFTER_MS, MIN_RESTART_INTERVAL_MS, noteLiveEvidenceGaps, retainEvidenceGapHeads } =
	await import('./evidence-gap-watchdog');

const HEAD = 'head-1';
const LOCK = 'c46a7a7e#0';
const LATER_LOCK = '3913480a#0';

function makeNode() {
	return { restartHistoryReplay: jest.fn() as AnyMock, status: 'Open' as HydraHeadStatus };
}

describe('noteLiveEvidenceGaps', () => {
	beforeEach(() => {
		retainEvidenceGapHeads(new Set());
		mockRecordHeadError.mockReset();
		mockRecordHeadError.mockResolvedValue(undefined);
	});

	it('leaves a short gap alone: the frame may still be on its way', () => {
		const node = makeNode();
		expect(noteLiveEvidenceGaps(HEAD, [LOCK], node, 0)).toBe(false);
		expect(noteLiveEvidenceGaps(HEAD, [LOCK], node, EVIDENCE_GAP_RESTART_AFTER_MS - 1)).toBe(false);
		expect(node.restartHistoryReplay).not.toHaveBeenCalled();
	});

	it('restarts the history replay once a gap outlives the threshold, and records a head error', () => {
		const node = makeNode();
		noteLiveEvidenceGaps(HEAD, [LOCK], node, 0);
		expect(noteLiveEvidenceGaps(HEAD, [LOCK], node, EVIDENCE_GAP_RESTART_AFTER_MS)).toBe(true);
		expect(node.restartHistoryReplay).toHaveBeenCalledTimes(1);
		expect(mockRecordHeadError).toHaveBeenCalledWith(
			HEAD,
			'Open',
			'CommandFailed',
			expect.any(Error),
			'HistoryEvidenceGap',
		);
	});

	it('times the gap from when an output first lacked evidence, not from the newest gap', () => {
		const node = makeNode();
		noteLiveEvidenceGaps(HEAD, [LOCK], node, 0);
		noteLiveEvidenceGaps(HEAD, [LOCK, LATER_LOCK], node, EVIDENCE_GAP_RESTART_AFTER_MS / 2);
		expect(noteLiveEvidenceGaps(HEAD, [LOCK, LATER_LOCK], node, EVIDENCE_GAP_RESTART_AFTER_MS)).toBe(true);
	});

	it('restarts the clock for an output that gained evidence and then lost it again', () => {
		const node = makeNode();
		noteLiveEvidenceGaps(HEAD, [LOCK], node, 0);
		noteLiveEvidenceGaps(HEAD, [], node, 1_000);
		noteLiveEvidenceGaps(HEAD, [LOCK], node, 2_000);
		expect(noteLiveEvidenceGaps(HEAD, [LOCK], node, EVIDENCE_GAP_RESTART_AFTER_MS + 1_000)).toBe(false);
		expect(noteLiveEvidenceGaps(HEAD, [LOCK], node, EVIDENCE_GAP_RESTART_AFTER_MS + 2_000)).toBe(true);
	});

	it('gives one output at most one restart, so a gap replay cannot fill does not loop', () => {
		const node = makeNode();
		noteLiveEvidenceGaps(HEAD, [LOCK], node, 0);
		expect(noteLiveEvidenceGaps(HEAD, [LOCK], node, EVIDENCE_GAP_RESTART_AFTER_MS)).toBe(true);
		expect(noteLiveEvidenceGaps(HEAD, [LOCK], node, EVIDENCE_GAP_RESTART_AFTER_MS + MIN_RESTART_INTERVAL_MS * 10)).toBe(
			false,
		);
		expect(node.restartHistoryReplay).toHaveBeenCalledTimes(1);
	});

	it('spaces restarts for new gaps by the minimum interval', () => {
		const node = makeNode();
		noteLiveEvidenceGaps(HEAD, [LOCK], node, 0);
		const firstRestartMs = EVIDENCE_GAP_RESTART_AFTER_MS;
		expect(noteLiveEvidenceGaps(HEAD, [LOCK], node, firstRestartMs)).toBe(true);
		noteLiveEvidenceGaps(HEAD, [LOCK, LATER_LOCK], node, firstRestartMs + 1);
		expect(noteLiveEvidenceGaps(HEAD, [LOCK, LATER_LOCK], node, firstRestartMs + MIN_RESTART_INTERVAL_MS - 1)).toBe(
			false,
		);
		expect(noteLiveEvidenceGaps(HEAD, [LOCK, LATER_LOCK], node, firstRestartMs + MIN_RESTART_INTERVAL_MS)).toBe(true);
		expect(node.restartHistoryReplay).toHaveBeenCalledTimes(2);
	});

	it('records the head error under the head status the node reports', () => {
		const node = { ...makeNode(), status: 'Closed' as HydraHeadStatus };
		noteLiveEvidenceGaps(HEAD, [LOCK], node, 0);
		noteLiveEvidenceGaps(HEAD, [LOCK], node, EVIDENCE_GAP_RESTART_AFTER_MS);
		expect(mockRecordHeadError.mock.calls[0]?.[1]).toBe('Closed');
	});

	it('tracks heads independently', () => {
		const node = makeNode();
		noteLiveEvidenceGaps(HEAD, [LOCK], node, 0);
		expect(noteLiveEvidenceGaps('head-2', [LOCK], node, EVIDENCE_GAP_RESTART_AFTER_MS)).toBe(false);
	});

	it('forgets heads this process no longer reconciles', () => {
		const node = makeNode();
		noteLiveEvidenceGaps(HEAD, [LOCK], node, 0);
		retainEvidenceGapHeads(new Set(['head-2']));
		expect(noteLiveEvidenceGaps(HEAD, [LOCK], node, EVIDENCE_GAP_RESTART_AFTER_MS)).toBe(false);
	});
});
