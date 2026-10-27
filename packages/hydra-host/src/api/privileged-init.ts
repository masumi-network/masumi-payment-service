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
	try {
		await dispatchInit(admitted.apiPort);
	} catch (error) {
		logger.error(`[api] privileged Init dispatch to ${admitted.nodeId} failed: ${(error as Error).message}`);
		throw new HostApiError('node Init dispatch may have failed; reconcile before retrying', 502);
	}
}
