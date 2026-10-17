import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { renderNftables, type ResolvedPeerAllowlist } from './api/peer-allowlist.js';

// The script runs on the machine as root, so the tests swap in stub `nft`,
// `curl` and `flock` binaries. The `nft` stub keeps the "loaded" ruleset in a
// file and lists a chain by printing its block from that file.
const SCRIPT = resolve('packages/hydra-host/scripts/hydra-peer-firewall');
const RANGE = { start: 5001, count: 4 };

const NFT_STUB = `#!/bin/bash
set -euo pipefail
case "$1" in
-c) [[ -z "\${NFT_REJECT:-}" ]] ;;
-f) [[ -z "\${NFT_APPLY_FAIL:-}" ]] && cp "$2" "$NFT_STATE" ;;
list)
	[[ -f "$NFT_STATE" ]] || exit 1
	awk -v hook="$5" '$1 == "chain" && $2 == hook { on = 1 } on { print } on && $1 == "}" { exit }' "$NFT_STATE" | grep -q . || exit 1
	awk -v hook="$5" '$1 == "chain" && $2 == hook { on = 1 } on { print } on && $1 == "}" { exit }' "$NFT_STATE"
	;;
esac
`;
const CURL_STUB = `#!/bin/bash
cat > "$CURL_HEADERS"
[[ -f "$CURL_BODY" ]] && cat "$CURL_BODY"
`;
const FLOCK_STUB = '#!/bin/bash\nexit 0\n';

let dir: string;

function allowlist(): ResolvedPeerAllowlist {
	return {
		rules: [
			{
				nodeId: 'n1',
				peerPort: 5001,
				allowedHosts: ['203.0.113.7'],
				allowedIpv4Addresses: ['203.0.113.7'],
				resolutionErrors: [],
				closed: false,
			},
		],
		unusedPorts: [5002, 5003, 5004],
	};
}

function writeResponse(body: object) {
	writeFileSync(join(dir, 'response.json'), JSON.stringify(body));
}

function run(command: string, extraEnv: Record<string, string> = {}) {
	const result = spawnSync('bash', [SCRIPT, command], {
		encoding: 'utf8',
		env: {
			PATH: `${join(dir, 'bin')}:/usr/bin:/bin`,
			HYDRA_PEER_FIREWALL_CONFIG: join(dir, 'absent'),
			HYDRA_PEER_PORT_START: String(RANGE.start),
			HYDRA_PEER_PORT_COUNT: String(RANGE.count),
			HYDRA_PEER_RULES_FILE: join(dir, 'nftables.d', 'hydra-peer.nft'),
			HYDRA_PEER_LOCK_FILE: join(dir, 'lock'),
			HYDRA_ADMIN_TOKEN_FILE: join(dir, 'token'),
			NFT_STATE: join(dir, 'loaded.nft'),
			CURL_HEADERS: join(dir, 'headers'),
			CURL_BODY: join(dir, 'response.json'),
			...extraEnv,
		},
	});
	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function loaded(): string {
	return readFileSync(join(dir, 'loaded.nft'), 'utf8');
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'hydra-peer-firewall-'));
	for (const [name, body] of [
		['nft', NFT_STUB],
		['curl', CURL_STUB],
		['flock', FLOCK_STUB],
	]) {
		const path = join(dir, 'bin', name);
		spawnSync('mkdir', ['-p', join(dir, 'bin')]);
		writeFileSync(path, body);
		chmodSync(path, 0o755);
	}
	writeFileSync(join(dir, 'token'), 'admin-token\n');
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe('hydra-peer-firewall verify', () => {
	it('refuses startup when no peer table is loaded', () => {
		const result = run('verify');
		expect(result.status).toBe(1);
		expect(result.stdout).toBe('');
		expect(result.stderr).toContain('has no input chain loaded');
	});

	it('refuses a loaded table whose forward chain lacks the range drop', () => {
		writeFileSync(
			join(dir, 'loaded.nft'),
			[
				'table inet hydra_peer {',
				'\tchain input {',
				'\t\ttype filter hook input priority filter; policy accept;',
				'\t\ttcp dport 5001-5004 drop',
				'\t}',
				'\tchain forward {',
				'\t\ttype filter hook forward priority filter; policy accept;',
				'\t}',
				'}',
			].join('\n'),
		);
		const result = run('verify');
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('chain forward does not refuse 5001-5004');
	});

	it('refuses a drop that covers only part of the range', () => {
		run('baseline', { HYDRA_PEER_PORT_COUNT: '2' });
		const result = run('verify');
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('does not refuse 5001-5004');
	});
});

describe('hydra-peer-firewall baseline', () => {
	it('loads a deny-all ruleset for both hooks and verifies it', () => {
		const result = run('baseline');
		expect(result.status).toBe(0);
		expect(result.stdout).toBe('verified\n');
		expect(loaded()).not.toContain('accept\n');
		expect(loaded().match(/tcp dport 5001-5004 drop/g)).toHaveLength(2);
		expect(run('verify').status).toBe(0);
	});

	it('replaces accept rules left by an earlier run', () => {
		writeResponse({ peerRange: RANGE, rules: [], nftables: renderNftables(allowlist(), RANGE) });
		expect(run('refresh').status).toBe(0);
		expect(loaded()).toContain('203.0.113.7');

		expect(run('baseline').status).toBe(0);
		expect(loaded()).not.toContain('203.0.113.7');
	});

	it('fails closed when nft cannot apply it', () => {
		const result = run('baseline', { NFT_APPLY_FAIL: '1' });
		expect(result.status).toBe(1);
		expect(result.stdout).toBe('');
	});
});

describe('hydra-peer-firewall refresh', () => {
	it('applies the Host ruleset and sends the token only on stdin', () => {
		writeResponse({ peerRange: RANGE, rules: [], nftables: renderNftables(allowlist(), RANGE) });
		const result = run('refresh');
		expect(result.status).toBe(0);
		expect(result.stdout).toBe('verified\n');
		expect(loaded()).toContain('tcp dport 5001 ip saddr { 203.0.113.7 } accept');
		expect(readFileSync(join(dir, 'headers'), 'utf8')).toBe('Authorization: Bearer admin-token\n');
		expect(readFileSync(join(dir, 'nftables.d', 'hydra-peer.nft'), 'utf8')).toBe(loaded());
	});

	it('keeps the loaded ruleset when the fetch fails', () => {
		expect(run('baseline').status).toBe(0);
		const before = loaded();
		const result = run('refresh');
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('could not fetch the peer allow-list');
		expect(loaded()).toBe(before);
	});

	it('refuses a truncated ruleset that would flush every rule', () => {
		expect(run('baseline').status).toBe(0);
		const before = loaded();
		writeResponse({
			peerRange: RANGE,
			rules: [],
			nftables: 'add table inet hydra_peer\nflush table inet hydra_peer\n',
		});
		const result = run('refresh');
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('does not refuse 5001-5004 on exactly two hooks');
		expect(loaded()).toBe(before);
	});

	it('refuses a Host whose peer range differs from the machine range', () => {
		const wider = { start: 5001, count: 8 };
		writeResponse({ peerRange: wider, rules: [], nftables: renderNftables(allowlist(), wider) });
		const result = run('refresh');
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('Host peer range 5001+8 does not match 5001+4');
		expect(existsSync(join(dir, 'loaded.nft'))).toBe(false);
	});

	it('refuses to run without an admin token file', () => {
		const result = run('refresh', { HYDRA_ADMIN_TOKEN_FILE: '' });
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('HYDRA_ADMIN_TOKEN_FILE');
	});
});
