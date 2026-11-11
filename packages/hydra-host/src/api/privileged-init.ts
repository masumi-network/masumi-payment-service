/** Admin-only, one-command Init dispatch to a single supervised node. */
import type { NodeRegistryStore } from '../registry/store.js';
import { acceptsCommands } from '../registry/types.js';
import type { SupervisorLogger } from '../supervisor/supervisor.js';
import type { HostConfig } from '../config.js';
import { HostApiError } from './http-error.js';
import { assertSafeHostInitLedgerParams, type ReadCurrentL1Parameters } from './init-admission.js';
import { dispatchInit } from './proxy.js';

export async function dispatchPrivilegedInit(
	store: NodeRegistryStore,
	nodeId: string,
	logger: SupervisorLogger,
	config: Pick<HostConfig, 'network' | 'blockfrostProjectFile'>,
	readCurrentL1Parameters: ReadCurrentL1Parameters,
): Promise<void> {
	const record = await store.read(nodeId);
	if (record === null) throw new HostApiError('no such node', 404);
	if (!acceptsCommands(record)) throw new HostApiError('node cannot accept commands', 409);
	if (record.initDispatchAttemptedAt !== undefined) {
		throw new HostApiError('Init was already dispatched to this node; reconcile before retrying', 409);
	}
	await assertSafeHostInitLedgerParams(record, config, readCurrentL1Parameters);
	const admitted = await store.update(nodeId, (current) => {
		if (!acceptsCommands(current)) throw new HostApiError('node cannot accept commands', 409);
		if (current.initDispatchAttemptedAt !== undefined) {
			throw new HostApiError('Init was already dispatched to this node; reconcile before retrying', 409);
		}
		return { ...current, initDispatchAttemptedAt: new Date().toISOString() };
	});
	if (admitted === null) throw new HostApiError('no such node', 404);
	let refusedBeforeSubmission: string | null;
	try {
		({ refusedBeforeSubmission } = await dispatchInit(admitted.apiPort));
	} catch (error) {
		logger.error(`[api] privileged Init dispatch to ${admitted.nodeId} failed: ${(error as Error).message}`);
		throw new HostApiError('node Init dispatch may have failed; reconcile before retrying', 502);
	}
	if (refusedBeforeSubmission === null) return;
	// The node built no InitTx, so this attempt cannot confirm: the positive
	// evidence the reconciliation guide asks for. Kept, the marker refused every
	// retry its own advice asks for ("fund the node and try again"). Only this
	// attempt's marker is cleared.
	await store.update(nodeId, (current) => {
		if (current.initDispatchAttemptedAt !== admitted.initDispatchAttemptedAt) return current;
		const { initDispatchAttemptedAt: _cleared, ...rest } = current;
		return rest;
	});
	logger.warn(`[api] ${admitted.nodeId} refused Init before submitting it (${refusedBeforeSubmission})`);
	throw new HostApiError(
		`hydra-node refused to post the Init transaction (${refusedBeforeSubmission}); nothing was posted, so Init can be sent again once that is fixed`,
		409,
	);
}
