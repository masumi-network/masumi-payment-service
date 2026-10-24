import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve('packages/hydra-host/scripts/hydra-peer-egress');
const NFT_STUB = `#!/bin/bash
set -euo pipefail
case "$1" in
-c) [[ -z "\${NFT_REJECT:-}" ]] ;;
-f) [[ -z "\${NFT_APPLY_FAIL:-}" ]] && cp "$2" "$NFT_STATE" ;;
list)
	[[ -f "$NFT_STATE" ]] || exit 1
	awk '$1 == "chain" && $2 == "output" { on = 1 } on && $1 !~ /^#/ && NF { print } on && $1 == "}" { exit }' "$NFT_STATE"
	;;
esac
`;
const DOCKER_STUB = `#!/bin/bash
set -euo pipefail
if [[ "$1" == info ]]; then
	echo "$DOCKER_SECURITY"
elif [[ "$1" == inspect ]]; then
	case "$3" in
	*HostConfig.NetworkMode*) printf '%s,%s\\n' '"host","","hydra"' "$DOCKER_DNS" ;;
	*Config.Env*) echo "$DOCKER_ENV" ;;
	*State.Running*) echo "\${DOCKER_RUNNING:-false}" ;;
	esac
fi
`;
const FLOCK_STUB = '#!/bin/bash\nexit 0\n';

let dir: string;

function run(command: string, extraEnv: Record<string, string> = {}) {
	const result = spawnSync('bash', [SCRIPT, command], {
		encoding: 'utf8',
		env: {
			PATH: `${join(dir, 'bin')}:${process.env.PATH ?? '/usr/bin:/bin'}`,
			HYDRA_EGRESS_CONFIG: join(dir, 'absent'),
			HYDRA_EGRESS_RULES_FILE: join(dir, 'nftables.d', 'hydra-peer-egress.nft'),
			HYDRA_EGRESS_LOCK_FILE: join(dir, 'lock'),
			HYDRA_EGRESS_READY_DIR: join(dir, 'ready'),
			HYDRA_HOST_PEER_PORT_START: '5100',
			HYDRA_HOST_API_PORT_START: '4100',
			HYDRA_HOST_PEER_PORT_COUNT: '4',
			HYDRA_EGRESS_DNS_IPV4: '127.0.0.53,10.0.0.2',
			NFT_STATE: join(dir, 'loaded.nft'),
			DOCKER_ENV: JSON.stringify([
				'HYDRA_HOST_REQUIRE_PEER_EGRESS_FIREWALL=true',
				'HYDRA_HOST_PEER_PORT_START=5100',
				'HYDRA_HOST_API_PORT_START=4100',
				'HYDRA_HOST_PEER_PORT_COUNT=4',
			]),
			DOCKER_SECURITY: '["name=seccomp"]',
			DOCKER_DNS: '["127.0.0.53","10.0.0.2"]',
			...extraEnv,
		},
	});
	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'hydra-peer-egress-'));
	spawnSync('mkdir', ['-p', join(dir, 'bin')]);
	for (const [name, body] of [
		['nft', NFT_STUB],
		['docker', DOCKER_STUB],
		['flock', FLOCK_STUB],
	]) {
		const path = join(dir, 'bin', name);
		writeFileSync(path, body);
		chmodSync(path, 0o755);
	}
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('hydra-peer-egress', () => {
	it('refuses startup without a loaded output rule', () => {
		const result = run('verify');
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('no output chain loaded');
	});

	it('loads the UID rule with loopback, DNS, host-local, IPv4 and IPv6 guards', () => {
		const result = run('baseline', { HYDRA_EGRESS_UID: '10002' });
		expect(result.status).toBe(0);
		expect(result.stdout).toBe('verified\n');
		const loaded = readFileSync(join(dir, 'loaded.nft'), 'utf8');
		expect(loaded).toContain('meta skuid 10001 ct state established ct direction reply accept');
		expect(loaded).toContain('meta skuid 10001 ip daddr 127.0.0.1 tcp dport 4100-4103 accept');
		expect(loaded).toContain('meta skuid 10001 ip daddr 127.0.0.1 tcp dport 2478-2481 accept');
		expect(loaded).toContain('meta skuid 10001 ip daddr 127.0.0.53 udp dport 53 accept');
		expect(loaded).toContain('meta skuid 10001 ip daddr 10.0.0.2 tcp dport 53 accept');
		expect(loaded).toContain('meta skuid 10001 fib daddr type local drop');
		expect(loaded).toContain('meta skuid 10001 ip daddr 169.254.0.0/16 drop');
		expect(loaded).toContain('meta skuid 10001 ip6 daddr 64:ff9b::/96 drop');
		expect(loaded).not.toContain('tcp dport 8443 accept');
		expect(JSON.parse(readFileSync(join(dir, 'ready', 'ready'), 'utf8'))).toMatchObject({
			uid: 10001,
			peerStart: 5100,
			apiStart: 4100,
			count: 4,
		});
		expect(run('verify').status).toBe(0);
	});

	it('refuses a modified loaded rule, including an earlier broad accept', () => {
		expect(run('baseline').status).toBe(0);
		const path = join(dir, 'loaded.nft');
		writeFileSync(path, readFileSync(path, 'utf8').replace('fib daddr type local drop', 'fib daddr type local accept'));
		expect(run('verify').stderr).toContain('loaded output rules differ');
	});

	it('fails before applying when the container opt-in or port layout differs', () => {
		const result = run('baseline', { DOCKER_ENV: '["HYDRA_HOST_REQUIRE_PEER_EGRESS_FIREWALL=false"]' });
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('container must set HYDRA_HOST_REQUIRE_PEER_EGRESS_FIREWALL=true');
		expect(existsSync(join(dir, 'loaded.nft'))).toBe(false);
		const mismatch = run('baseline', {
			DOCKER_ENV: JSON.stringify([
				'HYDRA_HOST_REQUIRE_PEER_EGRESS_FIREWALL=true',
				'HYDRA_HOST_PEER_PORT_START=5001',
				'HYDRA_HOST_API_PORT_START=4100',
				'HYDRA_HOST_PEER_PORT_COUNT=4',
			]),
		});
		expect(mismatch.status).toBe(1);
		expect(mismatch.stderr).toContain('container HYDRA_HOST_PEER_PORT_START differs');
	});

	it('fails closed on a Docker user namespace mapping', () => {
		const result = run('baseline', { DOCKER_SECURITY: '["name=userns"]' });
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('Docker userns-remap changes the host UID');
	});

	it('fails closed on rootless Docker', () => {
		const result = run('baseline', { DOCKER_SECURITY: '["name=rootless"]' });
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('rootless Docker changes the host UID');
		expect(existsSync(join(dir, 'loaded.nft'))).toBe(false);
	});

	it('refuses a baseline while the old Host is still running', () => {
		const result = run('baseline', { DOCKER_RUNNING: 'true' });
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('stop the existing Hydra container');
		expect(existsSync(join(dir, 'loaded.nft'))).toBe(false);
	});

	it('rejects a malformed resolver exception', () => {
		const result = run('baseline', { HYDRA_EGRESS_DNS_IPV4: '169.254.169.254' });
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('invalid HYDRA_EGRESS_DNS_IPV4');
	});

	it('refuses a missing or different Docker DNS list before applying rules', () => {
		expect(run('baseline', { HYDRA_EGRESS_DNS_IPV4: '' }).stderr).toContain(
			'HYDRA_EGRESS_DNS_IPV4 must name the container IPv4 DNS servers',
		);
		const result = run('baseline', { DOCKER_DNS: '["127.0.0.53"]' });
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('container --dns servers differ');
		expect(existsSync(join(dir, 'loaded.nft'))).toBe(false);
	});

	it('leaves no incomplete ruleset when nft rejects the file', () => {
		const result = run('baseline', { NFT_REJECT: '1' });
		expect(result.status).toBe(1);
		expect(existsSync(join(dir, 'loaded.nft'))).toBe(false);
		expect(existsSync(join(dir, 'nftables.d', 'hydra-peer-egress.nft.new'))).toBe(false);
	});
});
