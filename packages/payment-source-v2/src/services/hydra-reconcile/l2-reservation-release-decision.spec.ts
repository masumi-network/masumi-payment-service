import { describe, expect, it } from '@jest/globals';
import { decideL2ReservationRelease } from './l2-reservation-release-decision';

const refs = [`${'a'.repeat(64)}#0`, `${'b'.repeat(64)}#2`];
const allUnspent = () => 'output-bytes';

describe('decideL2ReservationRelease', () => {
	it('records the first verified snapshot seen after expiry as the baseline', () => {
		expect(
			decideL2ReservationRelease({
				inputRefs: refs,
				snapshotNumber: 10n,
				baselineSnapshotNumber: undefined,
				readVerifiedOutput: allUnspent,
			}),
		).toEqual({ action: 'baseline', snapshotNumber: 10n });
	});

	it('holds on the baseline snapshot itself', () => {
		expect(
			decideL2ReservationRelease({
				inputRefs: refs,
				snapshotNumber: 10n,
				baselineSnapshotNumber: 10n,
				readVerifiedOutput: allUnspent,
			}),
		).toEqual({ action: 'hold' });
	});

	it('releases on a newer snapshot that still holds every input', () => {
		expect(
			decideL2ReservationRelease({
				inputRefs: refs,
				snapshotNumber: 11n,
				baselineSnapshotNumber: 10n,
				readVerifiedOutput: allUnspent,
			}),
		).toEqual({ action: 'release' });
	});

	it('holds when any input is spent or unreadable', () => {
		expect(
			decideL2ReservationRelease({
				inputRefs: refs,
				snapshotNumber: 11n,
				baselineSnapshotNumber: 10n,
				readVerifiedOutput: (reference) => (reference === refs[0] ? 'output-bytes' : null),
			}),
		).toEqual({ action: 'hold' });
	});

	it('holds when no inputs were recorded', () => {
		expect(
			decideL2ReservationRelease({
				inputRefs: [],
				snapshotNumber: 11n,
				baselineSnapshotNumber: 10n,
				readVerifiedOutput: allUnspent,
			}),
		).toEqual({ action: 'hold' });
	});
});
