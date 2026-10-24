import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertPeerEgressAttestation } from './peer-egress-attestation.js';

const PORTS = { peerStart: 5100, apiStart: 4100, monitoringStart: 6100, capacity: 4 };
const NOW = 1_800_000_000_000;
let dir: string;
let file: string;

function writeReady(overrides: Record<string, number> = {}): void {
	writeFileSync(
		file,
		JSON.stringify({
			uid: 10001,
			peerStart: PORTS.peerStart,
			apiStart: PORTS.apiStart,
			count: PORTS.capacity,
			verifiedAt: NOW - 1000,
			...overrides,
		}),
	);
	chmodSync(file, 0o644);
}

function check(): void {
	assertPeerEgressAttestation(PORTS, { path: file, now: NOW, expectedOwnerUid: process.getuid?.() ?? 0 });
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'hydra-egress-ready-'));
	file = join(dir, 'ready');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('peer egress startup attestation', () => {
	it('refuses node boot when the host firewall has no fresh receipt', () => {
		expect(check).toThrow(/is unavailable/);
		writeReady({ verifiedAt: NOW - 31_000 });
		expect(check).toThrow(/stale/);
		writeReady({ verifiedAt: NOW + 1000 });
		expect(check).toThrow(/future timestamp/);
	});

	it('accepts only a matching UID, port layout and protected file', () => {
		writeReady();
		expect(check).not.toThrow();
		writeReady({ uid: 10002 });
		expect(check).toThrow(/does not match/);
		writeReady({ apiStart: 4001 });
		expect(check).toThrow(/does not match/);
		writeReady();
		chmodSync(file, 0o666);
		expect(check).toThrow(/root-owned file without group or world write access/);
	});
});
