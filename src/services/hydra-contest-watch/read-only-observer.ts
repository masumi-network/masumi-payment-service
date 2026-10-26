/** A separate evidence socket for heads whose payment session is quarantined. */

import { logger } from '@masumi/payment-core/logger';
import { HydraNode } from '@/lib/hydra/hydra/node';
import { createWorkerAccumulatorComputer } from '@/lib/hydra/hydra/snapshot-accumulator-worker-client';
import { loadValidatedHeadConfiguration } from '@/services/hydra-connection-manager/head-configuration';

const snapshotAccumulator = createWorkerAccumulatorComputer();
const observers = new Map<string, Promise<HydraNode>>();

export async function readOnlyContestNode(headId: string): Promise<HydraNode> {
	let pending = observers.get(headId);
	const isExisting = pending !== undefined;
	if (!pending) {
		pending = openReadOnlyContestNode(headId);
		observers.set(headId, pending);
	}
	try {
		const node = await pending;
		if (isExisting) await node.connect();
		return node;
	} catch (error) {
		if (observers.get(headId) === pending) observers.delete(headId);
		if (isExisting) {
			const node = await pending;
			await node.disconnect().catch((disconnectError: unknown) => {
				logger.warn('[HydraContestWatch] could not close failed read-only observer', { headId, disconnectError });
			});
		}
		throw error;
	}
}

/**
 * This service's stored head configuration could not build the observer. Some
 * of these are HydraProtocolErrors, such as a malformed stored key, but the
 * node was never contacted, so the fault is on this side.
 */
export class ContestObserverConfigurationError extends Error {
	readonly cause?: unknown;

	constructor(message: string, options?: { cause?: unknown }) {
		super(message);
		this.cause = options?.cause;
		this.name = 'ContestObserverConfigurationError';
	}
}

async function openReadOnlyContestNode(headId: string): Promise<HydraNode> {
	const node = await buildReadOnlyContestNode(headId).catch((error: unknown) => {
		throw new ContestObserverConfigurationError(error instanceof Error ? error.message : 'Unknown error', {
			cause: error,
		});
	});
	try {
		await node.connect();
		return node;
	} catch (error) {
		await node.disconnect().catch((disconnectError: unknown) => {
			logger.warn('[HydraContestWatch] could not close failed read-only observer', { headId, disconnectError });
		});
		throw error;
	}
}

async function buildReadOnlyContestNode(headId: string): Promise<HydraNode> {
	const {
		configuredHead,
		nodeUrls,
		nodeAuthToken,
		localVerificationKey,
		remoteVerificationKeys,
		reconciledHistoryCursor,
	} = await loadValidatedHeadConfiguration(headId, { readOnlyContestObserver: true });
	return new HydraNode({
		httpUrl: nodeUrls.httpUrl,
		wsUrl: nodeUrls.wsUrl,
		expectedHeadId: configuredHead.headIdentifier ?? undefined,
		reconciledHistoryCursor,
		snapshotVerificationKeys: [localVerificationKey, ...remoteVerificationKeys],
		expectedNodeVerificationKey: localVerificationKey,
		trustLocalNodeSnapshotMetadata: true,
		retainConfirmedTransactions: false,
		authToken: nodeAuthToken,
		guardHostDestination: true,
		computeSnapshotAccumulator: snapshotAccumulator,
	});
}

/** Release sockets once a payment session is healthy or the head is terminal. */
export async function releaseUnusedContestObservers(neededHeadIds: ReadonlySet<string>): Promise<void> {
	for (const [headId, pending] of observers) {
		if (neededHeadIds.has(headId)) continue;
		observers.delete(headId);
		try {
			const node = await pending;
			await node.disconnect();
		} catch (error) {
			logger.warn('[HydraContestWatch] could not close read-only observer', { headId, error });
		}
	}
}
