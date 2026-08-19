/**
 * Bring a previous run's Hosts back up without wiping anything.
 *
 * The run directory holds each node's keys and persistence, so a finished run
 * can be resumed — which is the only way to reach a head it left open, or to
 * inspect state after the fact.
 *
 *   pnpm exec tsx scripts/hydra-e2e/resume.mts                  # report head status
 *   RESUME_TEARDOWN=1 pnpm exec tsx scripts/hydra-e2e/resume.mts  # and close it down
 *
 * Test support only.
 */

import path from 'node:path';
import { HOSTS, REPO_ROOT, hostEnv, type HostSpec } from './env.mjs';
import { headStatus, teardownHead, type NodeEndpoint } from './head-ws.mjs';
import { http, sleep, spawnTsx, stopAll, waitFor } from './procs.mjs';

const HOST_ENTRY = path.join(REPO_ROOT, 'packages', 'hydra-host', 'src', 'index.ts');

type NodeRow = { nodeId: string; state: string; desired: string };

function endpoint(spec: HostSpec, nodeId: string): NodeEndpoint {
	return { baseUrl: spec.baseUrl, nodeId, token: spec.userToken, label: `${spec.name}/${nodeId.slice(0, 8)}` };
}

async function main(): Promise<void> {
	for (const spec of HOSTS) {
		spawnTsx(`${spec.name}-resume`, HOST_ENTRY, hostEnv(spec));
	}

	for (const spec of HOSTS) {
		await waitFor(
			`${spec.name} control plane`,
			() => http(`${spec.baseUrl}/v1/capabilities`, { token: spec.adminToken }),
			(result) => result.status === 200,
			{ timeoutMs: 60_000 },
		);

		const listed = await http(`${spec.baseUrl}/v1/nodes`, { token: spec.adminToken });
		const nodes = ((listed.body ?? {}) as { nodes?: NodeRow[] }).nodes ?? [];
		const live = nodes.filter((node) => node.desired === 'Running');
		console.log(`${spec.name}: ${nodes.length} node(s), ${live.length} wanted running`);

		for (const node of live) {
			// The node API opens only once etcd has a quorum and the chain follower
			// has caught up, so give it room before concluding anything.
			await sleep(20_000);
			const target = endpoint(spec, node.nodeId);
			const status = await headStatus(target);
			console.log(`  ${node.nodeId}  head=${status}`);

			if (process.env.RESUME_TEARDOWN === '1' && status !== 'Idle' && !status.startsWith('error')) {
				const result = await teardownHead(target, (message) => console.log(`  ${message}`));
				console.log(`  ${node.nodeId}  ${result.path} -> ${result.finalStatus} (${result.ok ? 'ok' : 'FAILED'})`);
			}
		}
	}
}

main()
	.catch((error: unknown) => console.error((error as Error).message))
	.finally(async () => {
		await stopAll();
		process.exit(0);
	});
