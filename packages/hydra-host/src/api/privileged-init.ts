/** Admin-only, one-command Init dispatch to a single supervised node. */
import type { NodeRegistryStore } from '../registry/store.js';
import { acceptsCommands } from '../registry/types.js';
import type { SupervisorLogger } from '../supervisor/supervisor.js';
import { HostApiError } from './http-error.js';
import { dispatchInit } from './proxy.js';

export async function dispatchPrivilegedInit(
	store: NodeRegistryStore,
	nodeId: string,
	logger: SupervisorLogger,
): Promise<void> {
	const record = await store.read(nodeId);
	if (record === null) throw new HostApiError('no such node', 404);
	if (!acceptsCommands(record)) throw new HostApiError('node cannot accept commands', 409);
	try {
		await dispatchInit(record.apiPort);
	} catch (error) {
		logger.error(`[api] privileged Init dispatch to ${record.nodeId} failed: ${(error as Error).message}`);
		throw new HostApiError('node Init dispatch may have failed; reconcile before retrying', 502);
	}
}
