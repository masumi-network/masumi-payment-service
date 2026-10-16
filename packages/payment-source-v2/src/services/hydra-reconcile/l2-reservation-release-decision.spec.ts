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
				nudgeInputRef: null,
				readVerifiedOutput: allUnspent,
			}),
		).toEqual({ action: 'baseline', snapshotNumber: 10n });
	});

	it('awaits a newer snapshot on the baseline snapshot itself', () => {
		expect(
			decideL2ReservationRelease({
				inputRefs: refs,
				snapshotNumber: 10n,
				baselineSnapshotNumber: 10n,
				nudgeInputRef: null,
				readVerifiedOutput: allUnspent,
			}),
		).toEqual({ action: 'await-snapshot' });
	});

	it('releases on a newer snapshot that still holds every input', () => {
		expect(
			decideL2ReservationRelease({
				inputRefs: refs,
				snapshotNumber: 11n,
				baselineSnapshotNumber: 10n,
				nudgeInputRef: null,
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
				nudgeInputRef: null,
				readVerifiedOutput: (reference) => (reference === refs[0] ? 'output-bytes' : null),
			}),
		).toEqual({ action: 'hold' });
	});

	// The snapshot an idle head stops on after a top-up still lists the deposit
	// under utxoToCommit. Holding there waited for a snapshot only a nudge can
	// produce, so the wallet stayed pinned for good.
	it('awaits a newer snapshot when the only unreadable inputs are pending commits', () => {
		expect(
			decideL2ReservationRelease({
				inputRefs: refs,
				snapshotNumber: 10n,
				baselineSnapshotNumber: undefined,
				nudgeInputRef: null,
				readVerifiedOutput: (reference) => (reference === refs[0] ? 'output-bytes' : null),
				isPendingCommit: (reference) => reference === refs[1],
			}),
		).toEqual({ action: 'await-snapshot' });
	});

	it('still holds when one input is spent and another is a pending commit', () => {
		expect(
			decideL2ReservationRelease({
				inputRefs: refs,
				snapshotNumber: 10n,
				baselineSnapshotNumber: undefined,
				nudgeInputRef: null,
				readVerifiedOutput: () => null,
				isPendingCommit: (reference) => reference === refs[1],
			}),
		).toEqual({ action: 'hold' });
	});

	it('holds when no inputs were recorded', () => {
		expect(
			decideL2ReservationRelease({
				inputRefs: [],
				snapshotNumber: 11n,
				baselineSnapshotNumber: 10n,
				nudgeInputRef: null,
				readVerifiedOutput: allUnspent,
			}),
		).toEqual({ action: 'hold' });
	});

	describe('with a release nudge recorded', () => {
		const nudgeRef = `${'c'.repeat(64)}#1`;

		it('awaits the nudge while its input is still unspent, even on a newer snapshot', () => {
			expect(
				decideL2ReservationRelease({
					inputRefs: refs,
					snapshotNumber: 11n,
					baselineSnapshotNumber: 10n,
					nudgeInputRef: nudgeRef,
					readVerifiedOutput: allUnspent,
				}),
			).toEqual({ action: 'await-snapshot' });
		});

		it('releases once the nudge input is spent and every reserved input is not', () => {
			expect(
				decideL2ReservationRelease({
					inputRefs: refs,
					snapshotNumber: 11n,
					baselineSnapshotNumber: 10n,
					nudgeInputRef: nudgeRef,
					readVerifiedOutput: (reference) => (reference === nudgeRef ? null : 'output-bytes'),
				}),
			).toEqual({ action: 'release' });
		});

		it('still holds when a reserved input is spent', () => {
			expect(
				decideL2ReservationRelease({
					inputRefs: refs,
					snapshotNumber: 11n,
					baselineSnapshotNumber: 10n,
					nudgeInputRef: nudgeRef,
					readVerifiedOutput: (reference) => (reference === refs[0] ? 'output-bytes' : null),
				}),
			).toEqual({ action: 'hold' });
		});
	});
});
