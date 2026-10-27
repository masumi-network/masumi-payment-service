import { expect, it } from '@jest/globals';
import { correlateDecommitOutcome, type DecommitOutcomeCursor } from './decommit-resolution';

const OWN_ID = 'aa'.repeat(32);
const PEER_ID = 'bb'.repeat(32);

it('keeps the approved id across an unrelated rejected request and consumes it only once', () => {
	const cursor: DecommitOutcomeCursor = {};
	correlateDecommitOutcome(cursor, { outcome: 'approved', decommitTxId: OWN_ID });
	correlateDecommitOutcome(cursor, { outcome: 'invalid', decommitTxId: PEER_ID });
	expect(correlateDecommitOutcome(cursor, { outcome: 'finalized' })?.decommitTxId).toBe(OWN_ID);
	expect(correlateDecommitOutcome(cursor, { outcome: 'finalized' })).toBeUndefined();
});

it('refuses to guess between conflicting approvals in one stream', () => {
	const cursor: DecommitOutcomeCursor = {};
	correlateDecommitOutcome(cursor, { outcome: 'approved', decommitTxId: OWN_ID });
	correlateDecommitOutcome(cursor, { outcome: 'approved', decommitTxId: PEER_ID });
	expect(correlateDecommitOutcome(cursor, { outcome: 'finalized' })).toBeUndefined();
	correlateDecommitOutcome(cursor, { outcome: 'approved', decommitTxId: OWN_ID });
	expect(correlateDecommitOutcome(cursor, { outcome: 'finalized' })?.decommitTxId).toBe(OWN_ID);
});

it('ignores a conflicting named finalization without consuming the pending approval', () => {
	const cursor: DecommitOutcomeCursor = {};
	correlateDecommitOutcome(cursor, { outcome: 'approved', decommitTxId: OWN_ID });
	expect(correlateDecommitOutcome(cursor, { outcome: 'finalized', decommitTxId: PEER_ID })).toBeUndefined();
	expect(correlateDecommitOutcome(cursor, { outcome: 'finalized' })?.decommitTxId).toBe(OWN_ID);
});

it('keeps legacy explicitly named finalizations without relying on a timestamp', () => {
	expect(correlateDecommitOutcome({}, { outcome: 'finalized', decommitTxId: OWN_ID })?.decommitTxId).toBe(OWN_ID);
	expect(correlateDecommitOutcome({}, { outcome: 'finalized', observedAt: new Date() })).toBeUndefined();
});
