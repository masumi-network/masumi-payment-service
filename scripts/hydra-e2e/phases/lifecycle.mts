/**
 * Node lifecycle and durability.
 *
 * Two properties are load-bearing and only observable with real processes:
 * a stop drains the current snapshot round before killing the node, and a Host
 * restart restores every node from the durable registry without an operator.
 * The second is what makes the "no manual intervention after a crash"
 * requirement true rather than aspirational.
 */

import path from 'node:path';
import { check, equals, phase } from '../check.mjs';
import { REPO_ROOT, hostEnv } from '../env.mjs';
import { countHydraNodes, forget, http, sleep, spawnTsx, tail, waitFor } from '../procs.mjs';
import { readNode, waitForNodeApi } from './cluster.mjs';
import type { NodeHandle } from './provision.mjs';
import type { RunningHost } from './hosts.mjs';

const HOST_ENTRY = path.join(REPO_ROOT, 'packages', 'hydra-host', 'src', 'index.ts');

async function act(node: NodeHandle, action: string): Promise<number> {
	const result = await http(`${node.host.spec.baseUrl}/v1/nodes/${node.nodeId}/${action}`, {
		method: 'POST',
		token: node.host.spec.adminToken,
	});
	return result.status;
}

export async function checkLifecycle(nodes: NodeHandle[]): Promise<void> {
	const [subject, other] = nodes;

	phase('lifecycle: removal guard');
	const premature = await http(`${subject.host.spec.baseUrl}/v1/nodes/${subject.nodeId}`, {
		method: 'DELETE',
		token: subject.host.spec.adminToken,
	});
	check(
		'removing a running node without force is refused',
		premature.status >= 400,
		`status ${premature.status}: ${premature.text.slice(0, 120)}`,
	);
	const stillRunning = await readNode(subject);
	equals('the refused removal left the node Running', stillRunning.state, 'Running');

	phase('lifecycle: drain and stop');
	const before = await countHydraNodes();
	equals('two hydra-node processes before the stop', before, 2);

	const stopStatus = await act(subject, 'stop');
	check('the stop request was accepted', stopStatus === 202, `status ${stopStatus}`);

	try {
		const stopped = await waitFor(
			'the node to reach Stopped',
			() => readNode(subject),
			(view) => view.state === 'Stopped' || view.state === 'Failed',
			{ timeoutMs: 90_000, intervalMs: 2_000 },
		);
		equals('the node stopped cleanly', stopped.state, 'Stopped');
		equals('the desired state followed the stop', stopped.desired, 'Stopped');
	} catch (error) {
		check('the node stopped cleanly', false, (error as Error).message);
		console.log(`\n[2m--- ${subject.host.spec.name} log ---\n${tail(subject.host.process.logFile, 40)}[0m\n`);
	}

	await sleep(2_000);
	const after = await countHydraNodes();
	equals('the stopped node process is gone', after, 1);

	// The peer's *process* survives, but its API does not keep serving: a
	// two-member raft cluster has no quorum once one member leaves. That is
	// upstream behaviour, not ours, and it is why a head is unavailable while
	// either participant is down.
	const survivor = await readNode(other);
	equals('the peer node process is untouched', survivor.state, 'Running');

	phase('lifecycle: restart from persistence');
	const startStatus = await act(subject, 'start');
	check('the restart request was accepted', startStatus === 202, `status ${startStatus}`);

	// `start` is an intent, not a spawn: it returns 202 and the supervisor acts on
	// its next tick, so the process appears shortly afterwards rather than
	// immediately.
	let restored = await countHydraNodes();
	const spawnDeadline = Date.now() + 60_000;
	while (restored < 2 && Date.now() < spawnDeadline) {
		await sleep(3_000);
		restored = await countHydraNodes();
	}
	equals('both node processes are alive again', restored, 2);

	// The head is only usable again once quorum is back, which is the property
	// that matters to a caller — and the state is derived from it, so the API
	// answers first and `Running` follows within a tick.
	const servingAgain = await waitForNodeApi(subject);
	check('the restarted node serves its API again', servingAgain, servingAgain ? 'quorum restored' : 'never answered');
	const peerServing = await waitForNodeApi(other, 60_000);
	check('the peer recovered quorum too', peerServing, peerServing ? 'quorum restored' : 'never answered');

	try {
		const restarted = await waitFor(
			'the node to return to Running',
			() => readNode(subject),
			(view) => view.state === 'Running' || view.state === 'Failed',
			{ timeoutMs: 90_000, intervalMs: 2_000 },
		);
		check(
			'the node returned to Running on its existing persistence',
			restarted.state === 'Running',
			restarted.state === 'Failed' ? (restarted.failureReason ?? 'failed') : String(restarted.state),
		);
		// A deliberate stop and start is not a restart in the sense the counter
		// tracks: it counts retries within an *unhealthy* streak, and this node
		// came back up first time.
		equals('an operator restart that succeeded counts no retries', restarted.restartCount, 0);
	} catch (error) {
		check('the node returned to Running on its existing persistence', false, (error as Error).message);
		console.log(`\n[2m--- ${subject.host.spec.name} log ---\n${tail(subject.host.process.logFile, 40)}[0m\n`);
	}
}

/**
 * Kill a Host outright and bring it back.
 *
 * SIGKILL rather than SIGTERM on purpose: a graceful shutdown proves the drain
 * path, but the requirement is that an *ungraceful* death still recovers
 * unattended. This is also what exercises the heartbeat host lock — a pid check
 * would have left the volume permanently unbootable here.
 */
export async function checkHostCrashRecovery(host: RunningHost, nodes: NodeHandle[]): Promise<RunningHost> {
	phase('lifecycle: host crash recovery');

	const owned = nodes.filter((node) => node.host.spec.name === host.spec.name);
	host.process.child.kill('SIGKILL');
	forget(host.process);
	await sleep(3_000);

	const orphans = await countHydraNodes();
	check(
		'killing the host leaves its node processes orphaned, not cleaned up',
		orphans >= 1,
		`${orphans} hydra-node processes still alive`,
	);

	const replacement = spawnTsx(`${host.spec.name}-restarted`, HOST_ENTRY, hostEnv(host.spec));
	const revived: RunningHost = { spec: host.spec, process: replacement };

	try {
		await waitFor(
			'the replacement host to answer',
			() => http(`${host.spec.baseUrl}/v1/capabilities`, { token: host.spec.adminToken }),
			(result) => result.status === 200,
			{ timeoutMs: 90_000 },
		);
		check('the host booted again despite the unreleased lock', true, 'heartbeat lock treated the holder as stale');
	} catch (error) {
		check('the host booted again despite the unreleased lock', false, (error as Error).message);
		console.log(`\n[2m--- ${host.spec.name} restart log ---\n${tail(replacement.logFile, 40)}[0m\n`);
		return revived;
	}

	for (const node of owned) {
		const rebound: NodeHandle = { ...node, host: revived };
		try {
			const view = await waitFor(
				'the node to be reconciled back to Running',
				() => readNode(rebound),
				(value) => value.state === 'Running' || value.state === 'Failed',
				{ timeoutMs: 150_000, intervalMs: 3_000 },
			);
			check(
				'the node was restored automatically after the host crash',
				view.state === 'Running',
				view.state === 'Failed' ? (view.failureReason ?? 'failed') : String(view.state),
			);
		} catch (error) {
			check('the node was restored automatically after the host crash', false, (error as Error).message);
			console.log(`\n[2m--- ${host.spec.name} restart log ---\n${tail(replacement.logFile, 60)}[0m\n`);
		}

		const serving = await waitForNodeApi(rebound);
		check('the restored node serves its API again', serving, serving ? 'quorum restored' : 'never answered');
	}

	return revived;
}
