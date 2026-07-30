/**
 * End-to-end run of the Hydra Host on a developer machine.
 *
 * Two Hosts, two real hydra-node processes, one etcd cluster between them, and
 * the control plane in front of both. Native mode throughout — see env.mts for
 * why there is no container here.
 *
 *   pnpm exec tsx scripts/hydra-e2e/run.mts
 *
 * Leaves logs and node state under `.hydra-e2e/`. Exits non-zero if any check
 * failed.
 */

import { check, phase, summarise } from './check.mjs';
import {
	assertPrerequisites,
	ensureRunDirs,
	FUNDING_SIGNING_KEY_FILE,
	HOST_A,
	HOST_B,
	LOG_DIR,
	RUN_DIR,
} from './env.mjs';
import { killStrayNodes, stopAll } from './procs.mjs';
import { checkAuthTiers, checkCapabilities, startHosts } from './phases/hosts.mjs';
import { checkEscrowContract, crossLinkPeers, escrowAck, provisionOn } from './phases/provision.mjs';
import { checkClusterIdentity, checkNodeHealth, checkPeerConnection, startCluster } from './phases/cluster.mjs';
import { checkProxyAllowList, checkProxyWebSocket } from './phases/proxy.mjs';
import { checkHostCrashRecovery, checkLifecycle } from './phases/lifecycle.mjs';
import { checkHandshake } from './phases/handshake.mjs';
import { checkHeadInit } from './phases/head-init.mjs';

async function main(): Promise<number> {
	phase('preflight');
	const problems = assertPrerequisites();
	check('prerequisites are present', problems.length === 0, problems.join('; '));
	if (problems.length > 0) {
		return summarise();
	}
	// Reap anything an interrupted earlier run left holding our peer ports,
	// before wiping the directory those processes are reading from.
	const strays = await killStrayNodes();
	check('no hydra-node processes from an earlier run remain', true, strays === 0 ? 'none found' : `killed ${strays}`);
	ensureRunDirs();
	console.log(`  [2mrun directory ${RUN_DIR}[0m`);

	const hosts = await startHosts();
	await checkCapabilities(hosts);
	await checkAuthTiers(hosts);
	await checkEscrowContract(hosts[0]);

	const stamp = Date.now();
	const left = await provisionOn(hosts[0], `head-left-${stamp}`);
	const right = await provisionOn(hosts[1], `head-right-${stamp}`);
	await escrowAck(left);
	await escrowAck(right);
	await crossLinkPeers(left, right);

	const nodes = [left, right];
	await startCluster(nodes);
	await checkPeerConnection(nodes);
	await checkClusterIdentity(nodes);
	await checkNodeHealth(nodes);
	await checkProxyAllowList(nodes);
	await checkProxyWebSocket(nodes);
	await checkLifecycle(nodes);
	await checkHostCrashRecovery(hosts[0], nodes);
	await checkHeadInit(nodes, FUNDING_SIGNING_KEY_FILE);
	await checkHandshake(hosts[0].spec, hosts[1].spec);

	console.log(`\n[2mlogs in ${LOG_DIR}[0m`);
	console.log(`[2mhost A ${HOST_A.baseUrl}  host B ${HOST_B.baseUrl}[0m`);
	return summarise();
}

let exitCode = 1;
try {
	exitCode = await main();
} catch (error) {
	console.error(`\n[31mrun aborted:[0m ${(error as Error).stack ?? (error as Error).message}`);
	exitCode = 1;
} finally {
	await stopAll();
}
process.exit(exitCode);
