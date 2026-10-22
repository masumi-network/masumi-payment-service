import createHttpError from 'http-errors';
import { logger } from '@masumi/payment-core/logger';
import { HydraHostRequestError, removeHostNode } from '@/services/hydra-host/client';
import { decrypt } from '@/utils/security/encryption';

/**
 * Give the Host back the node of a head that has finished.
 *
 * A Host frees a node's slot only when the node is removed, and nothing else
 * removes the node of a finished head, so every head left a slot behind until
 * the Host reported itself full. The Host refuses a plain removal for a node
 * that has had peers, because its persistence directory may hold the only copy
 * of the head state; that is no longer true once the head is final, which is
 * the one case it tells the caller to force.
 *
 * Callers run this before deleting the rows that name the node, so a Host
 * failure keeps them and the delete can be retried.
 */
export async function releaseHostNodeOfFinishedHead(participant: {
	hostNodeId: string;
	HydraHost: { baseUrl: string; encryptedAdminToken: string | null; allowInsecureHttp: boolean };
}): Promise<void> {
	const { hostNodeId, HydraHost: host } = participant;
	if (host.encryptedAdminToken === null) {
		logger.warn(
			`hydra: deleting a finished head on a host with no admin token; node ${hostNodeId} and its peer port must be removed by hand`,
		);
		return;
	}
	try {
		await removeHostNode(host.baseUrl, decrypt(host.encryptedAdminToken), hostNodeId, {
			force: true,
			allowInsecureHttp: host.allowInsecureHttp,
		});
	} catch (error) {
		// A node the Host no longer has is the outcome this asks for, and what a
		// retry finds after an earlier attempt removed it.
		if (error instanceof HydraHostRequestError && error.status === 404) return;
		throw createHttpError(
			502,
			`the hydra host refused to remove node ${hostNodeId}: ${(error as Error).message}; nothing was deleted, try again`,
		);
	}
}
