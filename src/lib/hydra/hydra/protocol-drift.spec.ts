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
import { detectSnapshotDrift, MODELLED_SNAPSHOT_FIELDS, MODELLED_SNAPSHOT_OUTPUT_FIELDS } from './protocol-drift';

const FIXTURE_PATH = path.join(process.cwd(), 'src/lib/hydra/hydra/__fixtures__/recorded-snapshot-frames.json');
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as { frames: Array<Record<string, unknown>> };

// The frame fixture records key shapes only, with every value elided, so the
// outputs come from the recorded history instead — that one carries real UTxOs.
const HISTORY_PATH = path.join(process.cwd(), 'src/lib/hydra/hydra/__fixtures__/recorded-head-history.json');

function recordedOutputFields(): Set<string> {
	const fields = new Set<string>();
	const walk = (node: unknown): void => {
		if (Array.isArray(node)) {
			for (const entry of node) walk(entry);
			return;
		}
		if (typeof node !== 'object' || node === null) return;
		const record = node as Record<string, unknown>;
		for (const partition of ['utxo', 'utxoToCommit', 'utxoToDecommit']) {
			const outputs = record[partition];
			if (typeof outputs !== 'object' || outputs === null) continue;
			for (const output of Object.values(outputs)) {
				if (typeof output === 'object' && output !== null) {
					for (const field of Object.keys(output)) fields.add(field);
				}
			}
		}
		for (const value of Object.values(record)) walk(value);
	};
	walk(JSON.parse(readFileSync(HISTORY_PATH, 'utf8')));
	return fields;
}

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

	// Outputs are where an addition is most likely and least visible, and the one
	// place a strict schema used to sit: an added key threw at parse time, which
	// on the replay path is permanent — history replays from the start on every
	// reconnect, so the same frame is rejected forever and the head never gets a
	// verified session.
	it('models exactly the output fields the recorded history carries', () => {
		expect([...recordedOutputFields()].sort()).toEqual([...MODELLED_SNAPSHOT_OUTPUT_FIELDS].sort());
	});

	it('names an unknown output field once, not once per UTxO', () => {
		const output = { address: 'addr1', value: {}, referenceScript: null, stakeAddress: 'stake1' };
		const drift = detectSnapshotDrift({
			tag: 'SnapshotConfirmed',
			snapshot: {
				number: 1,
				utxo: { [`${'a'.repeat(64)}#0`]: output, [`${'b'.repeat(64)}#0`]: output },
				utxoToDecommit: { [`${'c'.repeat(64)}#0`]: output },
			},
		});

		expect(drift).toEqual([{ location: 'output', fields: ['stakeAddress'] }]);
	});

	it('names an unknown frame field', () => {
		const drift = detectSnapshotDrift({ tag: 'SnapshotConfirmed', snapshot: {}, epoch: 4 });

		expect(drift.some((entry) => entry.location === 'frame' && entry.fields.includes('epoch'))).toBe(true);
	});
});
