/**
 * The silence clock only runs where silence means something.
 *
 * A `Starting` node that has never answered is coming up — with two
 * participants etcd has no quorum until the peer arrives. A `Running` node has
 * answered a probe, so the same silence is a wedged process.
 */

import { describe, expect, it } from '@jest/globals';
import { MUTE_STALL_MS, muteFields, shouldRestartForMute } from './mute.js';

const NOW = Date.parse('2026-08-18T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe('muteFields', () => {
	it('starts the clock when a running node goes quiet', () => {
		expect(muteFields({ state: 'Running' }, { processRunning: true, responsive: false, nowMs: NOW })).toEqual({
			muteSince: new Date(NOW).toISOString(),
		});
	});

	it('holds the original timestamp across further quiet ticks', () => {
		const started = ago(60_000);
		expect(
			muteFields({ state: 'Running', muteSince: started }, { processRunning: true, responsive: false, nowMs: NOW }),
		).toEqual({});
	});

	it('clears the clock as soon as the node answers', () => {
		expect(
			muteFields({ state: 'Running', muteSince: ago(60_000) }, { processRunning: true, responsive: true, nowMs: NOW }),
		).toEqual({ muteSince: undefined });
	});

	// The unbounded wait this whole clock is careful not to break.
	it('does not clock a node that has never answered', () => {
		expect(muteFields({ state: 'Starting' }, { processRunning: true, responsive: false, nowMs: NOW })).toEqual({});
	});

	// That is the start budget's business, and clocking it would restart a node
	// the planner is already trying to start.
	it('does not clock a node whose process is gone', () => {
		expect(muteFields({ state: 'Running' }, { processRunning: false, responsive: false, nowMs: NOW })).toEqual({});
	});
});

describe('shouldRestartForMute', () => {
	it('says nothing about a node with no clock running', () => {
		expect(shouldRestartForMute({}, NOW)).toBe(false);
	});

	it('waits out the window', () => {
		expect(shouldRestartForMute({ muteSince: ago(MUTE_STALL_MS - 1_000) }, NOW)).toBe(false);
		expect(shouldRestartForMute({ muteSince: ago(MUTE_STALL_MS + 1_000) }, NOW)).toBe(true);
	});

	it('honours the cooldown, so a node that comes back mute does not loop', () => {
		const stale = { muteSince: ago(MUTE_STALL_MS + 1_000), lastMuteRestartAt: ago(60_000) };
		expect(shouldRestartForMute(stale, NOW)).toBe(false);
		expect(shouldRestartForMute({ ...stale, lastMuteRestartAt: ago(30 * 60_000) }, NOW)).toBe(true);
	});

	it('ignores an unparseable timestamp rather than restarting on it', () => {
		expect(shouldRestartForMute({ muteSince: 'not a date' }, NOW)).toBe(false);
	});
});
