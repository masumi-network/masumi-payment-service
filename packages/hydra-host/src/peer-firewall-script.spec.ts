import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { renderNftables, type ResolvedPeerAllowlist } from './api/peer-allowlist.js';

// The script runs on the machine as root, so the tests swap in stub `nft`,
// `curl` and `flock` binaries. The `nft` stub keeps the "loaded" ruleset in a
// file and lists a chain the way nft does: its block, without comments or
// blank lines.
const SCRIPT = resolve('packages/hydra-host/scripts/hydra-peer-firewall');
const RANGE = { start: 5001, count: 4 };
const GENERATION = '0b6f3c1e-2d4a-4f5b-9c8d-7e6f5a4b3c2d.3';

const NFT_STUB = `#!/bin/bash
set -euo pipefail
case "$1" in
-c) [[ -z "\${NFT_REJECT:-}" ]] ;;
-f) [[ -z "\${NFT_APPLY_FAIL:-}" ]] && cp "$2" "$NFT_STATE" ;;
list)
	[[ -f "$NFT_STATE" ]] || exit 1
	out=$(awk -v hook="$5" '$1 == "chain" && $2 == hook { on = 1 } on && $1 !~ /^#/ && NF { print } on && $1 == "}" { exit }' "$NFT_STATE")
	[[ -n "$out" ]] || exit 1
	printf 'table inet hydra_peer {\n%s\n}\n' "$out"
	;;
esac
`;
// A POST is the acknowledgement: its arguments are recorded, and
// CURL_ACK_FAIL makes the Host refuse it the way `curl -f` reports a 4xx.
const CURL_STUB = `#!/bin/bash
cat > "$CURL_HEADERS"
printf '%s\\n' "$@" >> "$CURL_ARGS"
if [[ " $* " == *" --data-binary "* ]]; then
	printf '%s\\n' "$@" >> "$CURL_ACKS"
	[[ -z "\${CURL_ACK_FAIL:-}" ]] || exit 22
	exit 0
fi
[[ -f "$CURL_BODY" ]] && cat "$CURL_BODY"
`;
const FLOCK_STUB = '#!/bin/bash\nexit 0\n';

let dir: string;
let controlSocket: Server;

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
		outOfRange: [],
	};
}

function writeResponse(body: object) {
	writeFileSync(join(dir, 'response.json'), JSON.stringify({ generation: GENERATION, ...body }));
}

function acks(): string[] {
	const path = join(dir, 'acks');
	return existsSync(path)
		? readFileSync(path, 'utf8')
				.split('\n')
				.filter((line) => line.startsWith('{'))
		: [];
}

function run(command: string, extraEnv: Record<string, string> = {}) {
	const result = spawnSync('bash', [SCRIPT, command], {
		encoding: 'utf8',
		env: {
			PATH: `${join(dir, 'bin')}:${process.env.PATH ?? '/usr/bin:/bin'}`,
			HYDRA_PEER_FIREWALL_CONFIG: join(dir, 'absent'),
			HYDRA_PEER_PORT_START: String(RANGE.start),
			HYDRA_PEER_PORT_COUNT: String(RANGE.count),
			HYDRA_PEER_RULES_FILE: join(dir, 'nftables.d', 'hydra-peer.nft'),
			HYDRA_PEER_LOCK_FILE: join(dir, 'lock'),
			HYDRA_ADMIN_TOKEN_FILE: join(dir, 'token'),
			HYDRA_CONTROL_SOCKET: join(dir, 'control.sock'),
			HYDRA_CONTROL_SOCKET_UID: String(process.getuid?.() ?? 10001),
			NFT_STATE: join(dir, 'loaded.nft'),
			CURL_HEADERS: join(dir, 'headers'),
			CURL_ARGS: join(dir, 'curl-args'),
			CURL_BODY: join(dir, 'response.json'),
			CURL_ACKS: join(dir, 'acks'),
			...extraEnv,
		},
	});
	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function loadChains(input: string[], forward: string[]) {
	const chain = (hook: string, rules: string[]) => [
		`\tchain ${hook} {`,
		`\t\ttype filter hook ${hook} priority filter; policy accept;`,
		...rules.map((rule) => `\t\t${rule}`),
		'\t}',
	];
	writeFileSync(
		join(dir, 'loaded.nft'),
		['table inet hydra_peer {', ...chain('input', input), ...chain('forward', forward), '}'].join('\n'),
	);
}

function loaded(): string {
	return readFileSync(join(dir, 'loaded.nft'), 'utf8');
}

beforeEach(async () => {
	dir = mkdtempSync(join(realpathSync(tmpdir()), 'hydra-peer-firewall-'));
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
	controlSocket = createServer();
	await new Promise<void>((resolve, reject) => {
		controlSocket.once('error', reject);
		controlSocket.listen(join(dir, 'control.sock'), resolve);
	});
});

afterEach(async () => {
	await new Promise<void>((resolve) => controlSocket.close(() => resolve()));
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
		loadChains(['tcp dport 5001-5004 drop'], []);
		const result = run('verify');
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('chain forward does not end by refusing 5001-5004');
	});

	it('refuses an accept without a source set, which makes the drop dead', () => {
		const rules = ['tcp dport 5001 accept', 'tcp dport 5001-5004 drop'];
		loadChains(rules, rules);
		const result = run('verify');
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('chain input has a rule other than a source-scoped accept: tcp dport 5001 accept');
	});

	it('refuses a chain whose last rule is not the range drop', () => {
		const rules = ['tcp dport 5001-5004 drop', 'tcp dport 5001 ip saddr { 203.0.113.7 } accept'];
		loadChains(rules, rules);
		const result = run('verify');
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('chain input does not end by refusing 5001-5004');
	});

	// nft lists a one-element anonymous set as a plain address.
	it('accepts a single-address accept the way nft lists it', () => {
		const rules = ['tcp dport 5001 ip saddr 203.0.113.7 accept', 'tcp dport 5001-5004 drop'];
		loadChains(rules, rules);
		expect(run('verify')).toEqual({ status: 0, stdout: 'verified\n', stderr: '' });
	});

	it('refuses a port setting with a leading zero, which bash reads as octal', () => {
		const result = run('baseline', { HYDRA_PEER_PORT_START: '05001' });
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('must be positive integers');
		expect(existsSync(join(dir, 'loaded.nft'))).toBe(false);
	});

	it('accepts source-scoped accepts before the range drop', () => {
		const rules = ['tcp dport 5001 ip saddr { 203.0.113.7, 203.0.113.8 } accept', 'tcp dport 5001-5004 drop'];
		loadChains(rules, rules);
		expect(run('verify')).toEqual({ status: 0, stdout: 'verified\n', stderr: '' });
	});

	it('refuses a drop that covers only part of the range', () => {
		run('baseline', { HYDRA_PEER_PORT_COUNT: '2' });
		const result = run('verify');
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('does not end by refusing 5001-5004');
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
		writeResponse({ peerRange: RANGE, rules: allowlist().rules, nftables: renderNftables(allowlist(), RANGE) });
		expect(run('refresh').status).toBe(0);
		expect(loaded()).toContain('203.0.113.7');

		expect(run('baseline').status).toBe(0);
		expect(loaded()).not.toContain('203.0.113.7');
	});

	it('renders a one-port range as a single port', () => {
		const result = run('baseline', { HYDRA_PEER_PORT_COUNT: '1' });
		expect(result.status).toBe(0);
		expect(loaded()).not.toContain('5001-5001');
		expect(loaded().match(/tcp dport 5001 drop/g)).toHaveLength(2);
	});

	it('fails closed when nft cannot apply it', () => {
		const result = run('baseline', { NFT_APPLY_FAIL: '1' });
		expect(result.status).toBe(1);
		expect(result.stdout).toBe('');
	});
});

describe('hydra-peer-firewall refresh', () => {
	it('applies validated peer rules and sends the token only over the private socket', () => {
		writeResponse({ peerRange: RANGE, rules: allowlist().rules, nftables: renderNftables(allowlist(), RANGE) });
		const result = run('refresh');
		expect(result.status).toBe(0);
		expect(result.stdout).toBe('verified\n');
		expect(loaded()).toContain('tcp dport 5001 ip saddr { 203.0.113.7 } accept');
		expect(readFileSync(join(dir, 'headers'), 'utf8')).toBe('Authorization: Bearer admin-token\n');
		const curlArgs = readFileSync(join(dir, 'curl-args'), 'utf8');
		expect(curlArgs.match(/--unix-socket/g)).toHaveLength(2);
		expect(curlArgs.match(/--noproxy/g)).toHaveLength(2);
		expect(curlArgs).toContain(join(dir, 'control.sock'));
		expect(curlArgs).not.toContain('127.0.0.1:8443');
		expect(readFileSync(join(dir, 'nftables.d', 'hydra-peer.nft'), 'utf8')).toBe(loaded());
		expect(acks()).toEqual([`{"generation":"${GENERATION}"}`]);
		expect(readFileSync(join(dir, 'acks'), 'utf8')).toContain('/v1/peer-allowlist/applied');
	});

	// An acknowledgement frees released peer ports, so it must never describe a
	// ruleset that is not the one loaded.
	it('does not acknowledge a ruleset that nft failed to apply', () => {
		writeResponse({ peerRange: RANGE, rules: allowlist().rules, nftables: renderNftables(allowlist(), RANGE) });
		const result = run('refresh', { NFT_APPLY_FAIL: '1' });
		expect(result.status).toBe(1);
		expect(acks()).toEqual([]);
	});

	it('fails when the Host does not record the acknowledgement', () => {
		writeResponse({ peerRange: RANGE, rules: allowlist().rules, nftables: renderNftables(allowlist(), RANGE) });
		const result = run('refresh', { CURL_ACK_FAIL: '1' });
		expect(result.status).toBe(1);
		expect(result.stdout).toBe('');
		expect(result.stderr).toContain('the Host did not record it; released peer ports stay blocked');
		expect(loaded()).toContain('tcp dport 5001 ip saddr { 203.0.113.7 } accept');
	});

	// The script may be upgraded before the Host it serves.
	it('applies the ruleset of a Host that sends no generation, without acknowledging', () => {
		writeFileSync(
			join(dir, 'response.json'),
			JSON.stringify({ peerRange: RANGE, rules: allowlist().rules, nftables: renderNftables(allowlist(), RANGE) }),
		);
		const result = run('refresh');
		expect(result.status).toBe(0);
		expect(result.stdout).toBe('verified\n');
		expect(result.stderr).toContain('nothing to acknowledge');
		expect(loaded()).toContain('tcp dport 5001 ip saddr { 203.0.113.7 } accept');
		expect(acks()).toEqual([]);
	});

	it('refuses to put a malformed generation into the acknowledgement', () => {
		writeResponse({
			peerRange: RANGE,
			rules: allowlist().rules,
			nftables: renderNftables(allowlist(), RANGE),
			generation: 'x", "generation": "y.1',
		});
		const result = run('refresh');
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('generation is malformed');
		expect(acks()).toEqual([]);
	});

	it('keeps the loaded ruleset when the fetch fails', () => {
		expect(run('baseline').status).toBe(0);
		const before = loaded();
		const result = run('refresh');
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('could not fetch the peer allow-list');
		expect(loaded()).toBe(before);
	});

	it('never passes Host-supplied nftables commands to root nft', () => {
		writeResponse({
			peerRange: RANGE,
			rules: allowlist().rules,
			nftables: `flush ruleset\n${renderNftables(allowlist(), RANGE)}`,
		});
		const result = run('refresh');
		expect(result.status).toBe(0);
		expect(loaded()).toContain('tcp dport 5001 ip saddr { 203.0.113.7 } accept');
		expect(loaded()).not.toContain('flush ruleset');
	});

	it('refuses a truncated response before changing the loaded ruleset', () => {
		expect(run('baseline').status).toBe(0);
		const before = loaded();
		writeFileSync(join(dir, 'response.json'), '{"peerRange":');
		const result = run('refresh');
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('the peer allow-list response is invalid');
		expect(loaded()).toBe(before);
		// A rejected file left next to the persisted one could be loaded by a
		// wide nftables include glob at the next boot.
		expect(existsSync(join(dir, 'nftables.d', 'hydra-peer.nft.new'))).toBe(false);
		expect(existsSync(join(dir, 'nftables.d', 'hydra-peer.nft.response'))).toBe(false);
	});

	it('refuses an invalid IPv4 address before running nft', () => {
		const bad = allowlist();
		bad.rules[0].allowedIpv4Addresses = ['203.0.113.7\nflush ruleset'];
		writeResponse({ peerRange: RANGE, rules: bad.rules, nftables: renderNftables(allowlist(), RANGE) });
		const result = run('refresh');
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('Host peer address is not IPv4');
		expect(existsSync(join(dir, 'loaded.nft'))).toBe(false);
	});

	it('refuses to send the token without a private socket path', () => {
		writeResponse({ peerRange: RANGE, rules: allowlist().rules, nftables: renderNftables(allowlist(), RANGE) });
		const result = run('refresh', { HYDRA_CONTROL_SOCKET: '' });
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('HYDRA_CONTROL_SOCKET');
		expect(existsSync(join(dir, 'curl-args'))).toBe(false);
	});

	it('refuses to send the token when the socket directory becomes public', () => {
		writeResponse({ peerRange: RANGE, rules: allowlist().rules, nftables: renderNftables(allowlist(), RANGE) });
		chmodSync(dir, 0o755);
		const result = run('refresh');
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('the control socket directory must have mode 0700');
		expect(existsSync(join(dir, 'curl-args'))).toBe(false);
	});

	it('refuses to send the token to a socket with an unexpected owner', () => {
		writeResponse({ peerRange: RANGE, rules: allowlist().rules, nftables: renderNftables(allowlist(), RANGE) });
		const result = run('refresh', { HYDRA_CONTROL_SOCKET_UID: String((process.getuid?.() ?? 10001) + 1) });
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('wrong type or owner');
		expect(existsSync(join(dir, 'curl-args'))).toBe(false);
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
