import { describe, expect, it } from '@jest/globals';
import { isL2ReservationDeadInFinalSnapshot } from './l2-reservation-release-decision';

const refs = [`${'a'.repeat(64)}#0`, `${'b'.repeat(64)}#2`];
const allUnspent = () => 'output-bytes';

describe('isL2ReservationDeadInFinalSnapshot', () => {
	it('is dead when the final snapshot holds every input', () => {
		expect(isL2ReservationDeadInFinalSnapshot({ inputRefs: refs, readFinalOutput: allUnspent })).toBe(true);
	});

	it('holds when any input is missing from the final snapshot', () => {
		expect(
			isL2ReservationDeadInFinalSnapshot({
				inputRefs: refs,
				readFinalOutput: (reference) => (reference === refs[1] ? null : 'output-bytes'),
			}),
		).toBe(false);
	});

	it('holds a reservation with no known inputs', () => {
		expect(isL2ReservationDeadInFinalSnapshot({ inputRefs: [], readFinalOutput: allUnspent })).toBe(false);
	});
});
