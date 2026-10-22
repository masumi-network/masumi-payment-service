import { describe, expect, it } from '@jest/globals';
import { pageClosedBeforeHeadExisted } from './node-history-page';

const HEAD_ID = 'ab'.repeat(28);
const frame = (message: object) => JSON.stringify(message);

describe('pageClosedBeforeHeadExisted', () => {
	it('reads an Idle Greetings that names no head as a page written before the head', () => {
		expect(
			pageClosedBeforeHeadExisted([frame({ tag: 'PeerConnected' }), frame({ tag: 'Greetings', headStatus: 'Idle' })]),
		).toBe(true);
	});

	it('does not restart for a Greetings that names a head', () => {
		expect(pageClosedBeforeHeadExisted([frame({ tag: 'Greetings', headStatus: 'Idle', hydraHeadId: HEAD_ID })])).toBe(
			false,
		);
		expect(pageClosedBeforeHeadExisted([frame({ tag: 'Greetings', headStatus: 'Idle', headId: HEAD_ID })])).toBe(false);
	});

	it('does not restart for a head that was already past Idle', () => {
		expect(pageClosedBeforeHeadExisted([frame({ tag: 'Greetings', headStatus: 'Open' })])).toBe(false);
	});

	// The normal pass then rejects the frame with its own message.
	it('leaves a malformed page to the normal pass', () => {
		expect(pageClosedBeforeHeadExisted(['{not json', frame({ tag: 'Greetings', headStatus: 'Idle' })])).toBe(false);
	});
});
