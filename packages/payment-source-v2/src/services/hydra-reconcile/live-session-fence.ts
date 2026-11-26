import type { HydraNode } from '@/lib/hydra/hydra/node';
import type { getHydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';

/**
 * `node` is the head's live session and no rollback fences it. A rollback still
 * queued is flushed first, so it fences a mutation that would otherwise race it.
 */
export async function isLiveUnfencedSession(
	connectionManager: Pick<
		ReturnType<typeof getHydraConnectionManager>,
		'getNode' | 'flushHeadStatus' | 'isStatusQuarantined'
	>,
	hydraHeadId: string,
	node: HydraNode,
): Promise<boolean> {
	if (connectionManager.getNode(hydraHeadId) !== node) return false;
	await connectionManager.flushHeadStatus(hydraHeadId);
	return connectionManager.getNode(hydraHeadId) === node && !connectionManager.isStatusQuarantined(hydraHeadId);
}
