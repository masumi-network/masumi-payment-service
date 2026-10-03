import { describe, expect, it } from '@jest/globals';
import type { CosignDeny, CosignMemberVerdict } from '../../../smart-wallet/cosign-client';
import { classifyCosignResult, type CosignOutcome } from './cosign-disposition';

const NOW = Date.parse('2026-09-29T12:00:00Z');
const LATER = '2026-09-29T12:05:00Z';
const EARLIER = '2026-09-29T11:55:00Z';
const IDS = ['p1', 'p2', 'p3'];

function member(purchaseId: string, verdict: CosignMemberVerdict['verdict'], denied?: string): CosignMemberVerdict {
	return {
		purchaseId,
		outputIndex: IDS.indexOf(purchaseId) + 1,
		verdict,
		denied,
		reasonEnglish: denied ? `reason for ${denied}` : undefined,
	};
}

function deny(overrides: Partial<CosignDeny>): CosignOutcome {
	return {
		httpStatus: 409,
		denied: {
			decisionId: 'dec_01M3P5ZM0EP8R4NCQWS7TBWZFZ',
			txBodyHash: 'a'.repeat(64),
			requiredSigners: [],
			denied: 'member_denied',
			members: IDS.map((id) => member(id, 'allowed')),
			alarm: false,
			journalRef: 'jr_1',
			...overrides,
		} as CosignDeny,
	};
}

describe('classifyCosignResult', () => {
	it('approves on 200', () => {
		const approved = { httpStatus: 200, approved: {} } as unknown as CosignOutcome;
		expect(classifyCosignResult(approved, IDS, true, NOW)).toEqual({ kind: 'approved' });
	});

	it.each([
		['a transport error', { transportError: 'timeout' } as CosignOutcome],
		[
			'a quorum outage',
			{ httpStatus: 503, unavailable: { reachable: 1, threshold: 3, retryAfterSec: 5 } } as unknown as CosignOutcome,
		],
		['utxo_unknown', deny({ denied: 'utxo_unknown', members: [] })],
		['clock_skew', deny({ denied: 'clock_skew', members: [] })],
		['reservation_conflict', deny({ denied: 'reservation_conflict', members: [] })],
	])('requeues everyone on %s', (_label, outcome) => {
		const result = classifyCosignResult(outcome, IDS, true, NOW);
		expect(result.kind).toBe('refused');
		if (result.kind !== 'refused') return;
		expect([...result.refused.keys()]).toEqual(IDS);
		expect([...result.refused.values()].every((disposition) => disposition.kind === 'retry')).toBe(true);
	});

	it.each(['asset_not_listed', 'payee_unpinned'])('parks everyone as a policy denial on %s', (code) => {
		const result = classifyCosignResult(deny({ denied: code, reasonEnglish: 'no' }), IDS, true, NOW);
		expect(result.kind).toBe('refused');
		if (result.kind !== 'refused') return;
		for (const disposition of result.refused.values()) {
			expect(disposition).toEqual({ kind: 'manual', policy: true, note: `Exchain ${code}: no (journal jr_1)` });
		}
	});

	it.each(['body_mismatch', 'something_new'])('parks everyone as unknown on %s', (code) => {
		const result = classifyCosignResult(deny({ denied: code }), IDS, true, NOW);
		if (result.kind !== 'refused') throw new Error('expected refused');
		expect([...result.refused.values()].every((d) => d.kind === 'manual' && !d.policy)).toBe(true);
	});

	it('rebuilds with the admitted set and sorts out the rest', () => {
		const result = classifyCosignResult(
			deny({
				members: [member('p1', 'allowed'), member('p2', 'denied', 'per_tx_cap'), member('p3', 'not_evaluated')],
				rebuild: { keep: ['p1'], batchId: '00000000-0000-4000-8000-000000000000', heldUntil: LATER },
			}),
			IDS,
			true,
			NOW,
		);
		expect(result.kind).toBe('rebuild');
		if (result.kind !== 'rebuild') return;
		expect(result.keep).toEqual(['p1']);
		expect(result.refused.get('p1')).toBeUndefined();
		expect(result.refused.get('p2')).toEqual({
			kind: 'manual',
			policy: true,
			note: 'Exchain per_tx_cap: reason for per_tx_cap (journal jr_1)',
		});
		expect(result.refused.get('p3')?.kind).toBe('retry');
	});

	it('requeues a velocity_burst member instead of parking it', () => {
		const result = classifyCosignResult(
			deny({ members: [member('p1', 'denied', 'velocity_burst')] }),
			['p1'],
			true,
			NOW,
		);
		if (result.kind !== 'refused') throw new Error('expected refused');
		expect(result.refused.get('p1')?.kind).toBe('retry');
	});

	it('requeues the admitted set when a rebuild is no longer allowed', () => {
		const outcome = deny({
			members: [member('p1', 'allowed'), member('p2', 'denied', 'daily_outflow')],
			rebuild: { keep: ['p1'], batchId: '00000000-0000-4000-8000-000000000000', heldUntil: LATER },
		});
		const result = classifyCosignResult(outcome, ['p1', 'p2'], false, NOW);
		if (result.kind !== 'refused') throw new Error('expected refused');
		expect(result.refused.get('p1')?.kind).toBe('retry');
		expect(result.refused.get('p2')?.kind).toBe('manual');
	});

	it('does not rebuild on an expired hold', () => {
		const outcome = deny({
			members: [member('p1', 'allowed'), member('p2', 'denied', 'daily_outflow')],
			rebuild: { keep: ['p1'], batchId: '00000000-0000-4000-8000-000000000000', heldUntil: EARLIER },
		});
		expect(classifyCosignResult(outcome, ['p1', 'p2'], true, NOW).kind).toBe('refused');
	});
});
