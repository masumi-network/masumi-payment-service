/**
 * The guard that notices a Hydra upgrade before it breaks a head.
 *
 * The fixture is the key shape of every SnapshotConfirmed a real hydra-node
 * emitted. Regenerate it against a newer node and this suite fails, which is
 * the point: an added field is a prompt to check whether the signed-state
 * transition check accounts for it, and that prompt has to arrive at review
 * time rather than as an offline head in production.
 */

import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { detectSnapshotDrift, MODELLED_SNAPSHOT_FIELDS } from './protocol-drift';

const FIXTURE_PATH = path.join(process.cwd(), 'src/lib/hydra/hydra/__fixtures__/recorded-snapshot-frames.json');
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as { frames: Array<Record<string, unknown>> };

describe('protocol drift', () => {
	it('reports nothing for the frames a real node emits', () => {
		for (const frame of fixture.frames) {
			expect(detectSnapshotDrift(frame)).toEqual([]);
		}
	});

	// If this fails after regenerating the fixture, hydra-node changed what a
	// snapshot carries. Decide whether the transition check accounts for the new
	// field, add a case to transition-shapes.spec.ts either way, and only then
	// add it to MODELLED_SNAPSHOT_FIELDS.
	it('models exactly the fields the recorded frames carry', () => {
		const recorded = new Set<string>();
		for (const frame of fixture.frames) {
			for (const field of Object.keys((frame.snapshot ?? {}) as Record<string, unknown>)) recorded.add(field);
		}
		expect([...recorded].sort()).toEqual([...MODELLED_SNAPSHOT_FIELDS].sort());
	});

	it('names an unknown snapshot field rather than failing closed', () => {
		const drift = detectSnapshotDrift({ tag: 'SnapshotConfirmed', snapshot: { number: 1, utxoToRefund: {} } });

		expect(drift).toEqual([{ location: 'snapshot', fields: ['utxoToRefund'] }]);
	});

	it('names an unknown frame field', () => {
		const drift = detectSnapshotDrift({ tag: 'SnapshotConfirmed', snapshot: {}, epoch: 4 });

		expect(drift.some((entry) => entry.location === 'frame' && entry.fields.includes('epoch'))).toBe(true);
	});
});
