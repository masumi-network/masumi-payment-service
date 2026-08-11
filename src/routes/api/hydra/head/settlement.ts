/**
 * Settling a head: close, then fanout.
 *
 * Split from the opening half of the lifecycle so both stay under the 750-line
 * limit, and the seam is a real one — these two end a head's life on chain,
 * where init and commit begin it. Close is the irreversible step an operator
 * has to be talked through; fanout is the one that can need several passes.
 *
 * Takes the two shared lifecycle schemas from the opening half, which nothing
 * here sends back, so the dependency runs one way.
 */

import {
	HydraErrorType,
	HydraHeadStatus,
	Prisma,
	TransactionLayer,
	TransactionStatus,
} from '@/generated/prisma/client';
import { adminAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { withSerializableSlotRetry } from '@masumi/payment-core/serializable-semaphore';
import { z } from '@masumi/payment-core/zod';
import createHttpError from 'http-errors';

import { HydraTransportError } from '@/lib/hydra';
import { getHydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';
import { recordHeadError } from '@/services/hydra-head-error/record';
import { describeCloseWithActiveWork } from '@/utils/hydra/close-with-active-work';

import { lifecycleInput, lifecycleOutput } from './lifecycle';

// --- Lifecycle: POST close ---

export async function beginHydraHeadClose(headId: string, acknowledgedActiveEscrows = false): Promise<void> {
	await withSerializableSlotRetry(
		() =>
			prisma.$transaction(
				async (tx) => {
					// Reservation writers take this same row lock before creating Pending
					// work. Whichever side wins becomes visible to the other before it can
					// proceed, closing the close-vs-submit race.
					const rows = await tx.$queryRaw<
						Array<{
							id: string;
							status: HydraHeadStatus;
							isEnabled: boolean;
							isClosing: boolean;
							initTxHash: string | null;
							contestationPeriod: bigint;
						}>
					>(Prisma.sql`
						SELECT "id", "status", "isEnabled", "isClosing", "initTxHash", "contestationPeriod"
						FROM "HydraHead"
						WHERE "id" = ${headId}
						FOR UPDATE
					`);
					const head = rows[0];
					if (!head) throw createHttpError(404, 'Hydra head not found');
					if (!head.isEnabled) throw createHttpError(409, 'Cannot close a disabled Hydra head');
					if (head.initTxHash == null) {
						throw createHttpError(409, 'Cannot close a Hydra head without verified InitTx evidence');
					}
					if (head.status !== HydraHeadStatus.Open) {
						throw createHttpError(409, `Cannot close: head status is ${head.status}, expected Open`);
					}
					if (head.isClosing) throw createHttpError(409, 'Hydra head close is already in progress');

					const pendingL2Transactions = await tx.transaction.count({
						where: {
							hydraHeadId: headId,
							layer: TransactionLayer.L2,
							status: TransactionStatus.Pending,
						},
					});
					const activePaymentEscrows = await tx.paymentRequest.count({
						where: {
							layer: TransactionLayer.L2,
							CurrentTransaction: { is: { hydraHeadId: headId, layer: TransactionLayer.L2 } },
							OR: [
								{
									currentHydraUtxoTxHash: { not: null },
									currentHydraUtxoOutputIndex: { not: null },
								},
								{ unresolvedHydraTerminalTxHash: { not: null } },
							],
						},
					});
					const activePurchaseEscrows = await tx.purchaseRequest.count({
						where: {
							layer: TransactionLayer.L2,
							CurrentTransaction: { is: { hydraHeadId: headId, layer: TransactionLayer.L2 } },
							OR: [
								{
									currentHydraUtxoTxHash: { not: null },
									currentHydraUtxoOutputIndex: { not: null },
								},
								{ unresolvedHydraTerminalTxHash: { not: null } },
							],
						},
					});
					const activeEscrows = activePaymentEscrows + activePurchaseEscrows;
					// Refused by default, but never forbidden. Closing with live escrows
					// fans them out to L1, where they stay collectible against the same
					// datums and deadlines — a change of settlement layer, not a loss.
					// Making it impossible turned a busy head into one that could never
					// be closed at all, which is the worse failure: the escrows keep
					// their deadlines whether or not the head can be shut down.
					if (!acknowledgedActiveEscrows && (pendingL2Transactions > 0 || activeEscrows > 0)) {
						throw createHttpError(
							409,
							describeCloseWithActiveWork(head.contestationPeriod, pendingL2Transactions, activeEscrows),
						);
					}

					const claimed = await tx.hydraHead.updateMany({
						where: {
							id: headId,
							status: HydraHeadStatus.Open,
							isEnabled: true,
							isClosing: false,
							initTxHash: { not: null },
						},
						data: { isClosing: true },
					});
					if (claimed.count !== 1) throw createHttpError(409, 'Hydra head close eligibility changed concurrently');
				},
				{
					isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
					maxWait: 10_000,
					timeout: 10_000,
				},
			),
		{ label: 'hydra-head-close-admission' },
	);
}

async function releaseHydraHeadCloseAdmission(headId: string): Promise<void> {
	await prisma.hydraHead.updateMany({
		where: { id: headId, status: HydraHeadStatus.Open, isClosing: true },
		data: { isClosing: false },
	});
}

export const closeHeadInput = lifecycleInput.extend({
	/**
	 * Close even though the head still holds escrows or unconfirmed work.
	 *
	 * Named rather than a bare force flag: what the operator is accepting is
	 * that those escrows move to L1 and must be collected there.
	 */
	acknowledgeActiveEscrows: z.boolean().optional(),
});

export const closeHeadPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: closeHeadInput,
	output: lifecycleOutput,
	handler: async ({ input }) => {
		const head = await prisma.hydraHead.findUnique({ where: { id: input.headId } });

		if (!head) {
			throw createHttpError(404, 'Hydra head not found');
		}
		if (!head.isEnabled) {
			throw createHttpError(409, 'Cannot close a disabled Hydra head');
		}

		if (head.status !== HydraHeadStatus.Open) {
			throw createHttpError(409, `Cannot close: head status is ${head.status}, expected Open`);
		}

		const cm = getHydraConnectionManager();
		const hydraHead = cm.getHead(head.id);
		if (!hydraHead) {
			throw createHttpError(502, 'No active connection to Hydra head');
		}

		try {
			await beginHydraHeadClose(head.id, input.acknowledgeActiveEscrows === true);
			await hydraHead.close();
			await cm.flushHeadStatus(head.id);
			const persistedHead = await prisma.hydraHead.findUnique({
				where: { id: head.id },
				select: { status: true },
			});
			if (!persistedHead) throw createHttpError(404, 'Hydra head not found');

			logger.info(`[HydraAPI] Head ${head.id} close completed`, { status: persistedHead.status });
			return { headId: head.id, status: persistedHead.status };
		} catch (error) {
			// Only a pre-send transport failure proves that neither this node nor a
			// concurrent party could have moved the head out of Open. Any response after
			// dispatch stays fail-closed until an authenticated status frame converges DB.
			if (error instanceof HydraTransportError) {
				await releaseHydraHeadCloseAdmission(head.id);
			}
			await recordHeadError(head.id, head.status, HydraErrorType.CommandFailed, error, 'Close');
			throw error;
		}
	},
});

// --- Lifecycle: POST fanout ---

export const fanoutHeadPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: lifecycleInput,
	output: lifecycleOutput,
	handler: async ({ input }) => {
		const head = await prisma.hydraHead.findUnique({ where: { id: input.headId } });

		if (!head) {
			throw createHttpError(404, 'Hydra head not found');
		}
		if (!head.isEnabled) {
			throw createHttpError(409, 'Cannot fanout a disabled Hydra head');
		}

		if (head.status !== HydraHeadStatus.FanoutPossible) {
			throw createHttpError(409, `Cannot fanout: head status is ${head.status}, expected FanoutPossible`);
		}

		const cm = getHydraConnectionManager();
		const hydraHead = cm.getHead(head.id);
		if (!hydraHead) {
			throw createHttpError(502, 'No active connection to Hydra head');
		}

		try {
			await hydraHead.fanout();
			await cm.flushHeadStatus(head.id);
			const persistedHead = await prisma.hydraHead.findUnique({
				where: { id: head.id },
				select: { status: true },
			});
			if (!persistedHead) throw createHttpError(404, 'Hydra head not found');

			logger.info(`[HydraAPI] Head ${head.id} fanout completed`, { status: persistedHead.status });
			return { headId: head.id, status: persistedHead.status };
		} catch (error) {
			await recordHeadError(head.id, head.status, HydraErrorType.CommandFailed, error, 'Fanout');
			throw error;
		}
	},
});
