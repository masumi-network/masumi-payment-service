import { describe, expect, it } from '@jest/globals';
import { describeParamDrift, findParamDrift } from './params-drift';

const IN_STEP = { utxoCostPerByte: 4310, maxValueSize: 5000 };

describe('findParamDrift', () => {
	it('reports nothing while the head matches the chain', () => {
		expect(findParamDrift(IN_STEP, IN_STEP)).toEqual([]);
	});

	/**
	 * The failure this exists to catch.
	 *
	 * Fanout is an L1 transaction and value cannot be added to an output on the
	 * way out, so an output created under a cheaper rate can be below the chain's
	 * minimum by the time it leaves — and the head cannot be settled at all.
	 */
	it('flags a head charging less per byte than the chain as blocking fanout', () => {
		const drift = findParamDrift({ ...IN_STEP, utxoCostPerByte: 4310 }, { ...IN_STEP, utxoCostPerByte: 5000 });

		expect(drift).toEqual([{ parameter: 'utxoCostPerByte', head: 4310, chain: 5000, blocksFanout: true }]);
		expect(describeParamDrift(drift)).toContain('rejected by L1');
	});

	// The other direction is worth reporting but cannot strand funds: outputs are
	// larger than the chain requires, so they leave the head easily.
	it('reports a head stricter than the chain without calling it fanout-blocking', () => {
		const drift = findParamDrift({ ...IN_STEP, utxoCostPerByte: 6000 }, IN_STEP);

		expect(drift[0]?.blocksFanout).toBe(false);
		expect(describeParamDrift(drift)).toContain('refuse commits');
	});

	// maxValueSize cuts the opposite way: a head permitting MORE than the chain
	// lets an output grow past what L1 will accept back.
	it('flags a head allowing a larger value than the chain', () => {
		const drift = findParamDrift({ ...IN_STEP, maxValueSize: 9000 }, IN_STEP);

		expect(drift).toEqual([{ parameter: 'maxValueSize', head: 9000, chain: 5000, blocksFanout: true }]);
	});

	it('reports every parameter that has moved', () => {
		const drift = findParamDrift(
			{ utxoCostPerByte: 4310, maxValueSize: 9000 },
			{ utxoCostPerByte: 5000, maxValueSize: 5000 },
		);

		expect(drift.map((d) => d.parameter).sort()).toEqual(['maxValueSize', 'utxoCostPerByte']);
		expect(drift.every((d) => d.blocksFanout)).toBe(true);
	});

	// The historical precedent: Babbage redefined the unit from per-word (34482)
	// to per-byte (4310). A head open across that boundary would have been
	// stricter, not stranded — but a 9.6x gap is exactly what must never go
	// unnoticed.
	it('catches a unit redefinition of the Babbage kind', () => {
		const drift = findParamDrift({ ...IN_STEP, utxoCostPerByte: 34482 }, { ...IN_STEP, utxoCostPerByte: 4310 });

		expect(drift).toHaveLength(1);
		expect(drift[0]?.blocksFanout).toBe(false);
	});
});
