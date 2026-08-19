/**
 * Bring both Hosts up and prove the control plane's auth tiers.
 *
 * The tier checks matter more than they look: hydra-node has no authentication
 * of its own, so the token check in front of the proxy is the entire boundary
 * between a counterparty's network and an API that can close a head.
 */

import path from 'node:path';
import { check, equals, phase } from '../check.mjs';
import { HOSTS, REPO_ROOT, hostEnv, type HostSpec } from '../env.mjs';
import { http, spawnTsx, tail, waitFor, type Managed } from '../procs.mjs';

const HOST_ENTRY = path.join(REPO_ROOT, 'packages', 'hydra-host', 'src', 'index.ts');

export type RunningHost = { spec: HostSpec; process: Managed };

export async function startHosts(): Promise<RunningHost[]> {
	phase('hosts: boot');

	const started = HOSTS.map((spec) => ({ spec, process: spawnTsx(spec.name, HOST_ENTRY, hostEnv(spec)) }));

	for (const host of started) {
		try {
			await waitFor(
				`${host.spec.name} control plane`,
				() => http(`${host.spec.baseUrl}/v1/capabilities`, { token: host.spec.adminToken }),
				(result) => result.status === 200,
				{ timeoutMs: 60_000 },
			);
			check(`${host.spec.name} control plane is listening`, true, host.spec.baseUrl);
		} catch (error) {
			check(`${host.spec.name} control plane is listening`, false, (error as Error).message);
			console.log(`\n[2m--- ${host.spec.name} log ---\n${tail(host.process.logFile)}[0m\n`);
		}
	}

	return started;
}

/**
 * The capabilities probe runs the real binary.
 *
 * `probeError: null` with a populated catalogue is the proof that this is a
 * genuine hydra-node and not a stub: the catalogue can only come from
 * `hydra-node --hydra-script-catalogue` actually executing.
 */
export async function checkCapabilities(hosts: RunningHost[]): Promise<void> {
	phase('hosts: capabilities');

	for (const host of hosts) {
		const result = await http(`${host.spec.baseUrl}/v1/capabilities`, { token: host.spec.adminToken });
		const body = (result.body ?? {}) as {
			hydraVersion?: string;
			probeError?: string | null;
			scriptCatalogue?: unknown;
			ledgerParamsHash?: string | null;
			network?: string;
			nodeSlots?: { used: number; capacity: number };
		};

		equals(`${host.spec.name} capabilities responds 200`, result.status, 200);
		check(
			`${host.spec.name} reports hydra 2.3.0`,
			(body.hydraVersion ?? '').startsWith('2.3.0'),
			body.hydraVersion ?? '(none)',
		);
		check(`${host.spec.name} probed the binary without error`, body.probeError == null, String(body.probeError));
		check(
			`${host.spec.name} returned a real script catalogue`,
			body.scriptCatalogue !== null && body.scriptCatalogue !== undefined,
			describeCatalogue(body.scriptCatalogue),
		);
		check(
			`${host.spec.name} hashed the ledger parameters`,
			typeof body.ledgerParamsHash === 'string' && body.ledgerParamsHash.startsWith('sha256:'),
			String(body.ledgerParamsHash),
		);
		equals(`${host.spec.name} reports its network`, body.network, 'preprod');
	}

	// Both Hosts run the same binary and the same params file, so a divergence
	// here would mean the placement compatibility guard has nothing to compare.
	const [a, b] = await Promise.all(
		hosts.map(async (host) => {
			const result = await http(`${host.spec.baseUrl}/v1/capabilities`, { token: host.spec.adminToken });
			return (result.body ?? {}) as { ledgerParamsHash?: string | null; scriptCatalogue?: unknown };
		}),
	);
	check(
		'both hosts agree on the ledger parameters hash',
		a.ledgerParamsHash === b.ledgerParamsHash && a.ledgerParamsHash != null,
		String(a.ledgerParamsHash),
	);
	check(
		'both hosts agree on the script catalogue',
		JSON.stringify(a.scriptCatalogue) === JSON.stringify(b.scriptCatalogue),
		describeCatalogue(a.scriptCatalogue),
	);
}

function describeCatalogue(catalogue: unknown): string {
	if (catalogue === null || catalogue === undefined) {
		return '(none)';
	}
	const text = JSON.stringify(catalogue);
	return `${text.slice(0, 90)}${text.length > 90 ? '…' : ''}`;
}

export async function checkAuthTiers(hosts: RunningHost[]): Promise<void> {
	phase('hosts: auth tiers');
	const host = hosts[0].spec;

	const cases: Array<{ label: string; url: string; method?: string; token?: string; expect: number }> = [
		{ label: 'capabilities without a token is refused', url: '/v1/capabilities', expect: 401 },
		{
			label: 'capabilities with a wrong token is refused',
			url: '/v1/capabilities',
			token: 'not-the-token-not-the-token-not-x',
			expect: 401,
		},
		{
			label: 'capabilities with the user token is forbidden',
			url: '/v1/capabilities',
			token: host.userToken,
			expect: 403,
		},
		{
			label: 'capabilities with the admin token is allowed',
			url: '/v1/capabilities',
			token: host.adminToken,
			expect: 200,
		},
		{ label: 'listing nodes with the user token is forbidden', url: '/v1/nodes', token: host.userToken, expect: 403 },
		{ label: 'listing nodes with the admin token is allowed', url: '/v1/nodes', token: host.adminToken, expect: 200 },
		{
			label: 'provisioning with the user token is forbidden',
			url: '/v1/nodes',
			method: 'POST',
			token: host.userToken,
			expect: 403,
		},
		{ label: 'an unrouted path is not found', url: '/v1/anything-else', token: host.adminToken, expect: 404 },
	];

	for (const testCase of cases) {
		const result = await http(`${host.baseUrl}${testCase.url}`, {
			method: testCase.method,
			token: testCase.token,
			...(testCase.method === 'POST' ? { idempotencyKey: 'auth-probe', body: {} } : {}),
		});
		equals(testCase.label, result.status, testCase.expect);
	}

	// Cross-host tokens must not work, or two Hosts behind one proxy would share
	// a trust boundary that the deployment model says they do not.
	const crossed = await http(`${hosts[1].spec.baseUrl}/v1/capabilities`, { token: hosts[0].spec.adminToken });
	equals("host B rejects host A's admin token", crossed.status, 401);
}
