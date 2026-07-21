import { adminAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { z } from '@masumi/payment-core/zod';
import { Network, TxSyncQuarantineReason } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import createHttpError from 'http-errors';
import { AuthContext, checkIsAllowedNetworkOrThrowUnauthorized } from '@masumi/payment-core/auth';

const quarantineStatusSchema = z.enum(['Pending', 'NeedsOperator', 'Resolved', 'All']);

export const getTxSyncQuarantineSchemaInput = z.object({
	network: z.nativeEnum(Network).optional().describe('Filter to a single network'),
	paymentSourceId: z.string().optional().describe('Filter to a single payment source'),
	status: quarantineStatusSchema
		.default('Pending')
		.optional()
		.describe(
			'Pending: awaiting retry. NeedsOperator: retries exhausted or a non-retryable failure. Resolved: already applied or discarded.',
		),
	take: z.coerce.number().int().min(1).max(100).default(25).optional().describe('How many entries to return'),
	cursorId: z.string().optional().describe('Id of the last entry of the previous page'),
});

export const txSyncQuarantineEntrySchema = z
	.object({
		id: z.string(),
		createdAt: z.date(),
		updatedAt: z.date(),
		txHash: z.string().describe('The transaction the sync could not apply'),
		blockHeight: z.number().nullable().describe('Chain position, when known'),
		txIndex: z.number().nullable(),
		reason: z.nativeEnum(TxSyncQuarantineReason).describe('Whether the lookup or the processing failed'),
		attempts: z.number().describe('How many retries the reconciler has already made'),
		lastError: z.string().nullable(),
		nextRetryAt: z.date().describe('The reconciler will not retry before this time'),
		resolvedAt: z.date().nullable().describe('Set once applied or discarded. Rows are retained for audit'),
		needsOperator: z.boolean().describe('Retries stopped; a human needs to look at it'),
		PaymentSource: z.object({
			id: z.string(),
			network: z.nativeEnum(Network),
			smartContractAddress: z.string(),
		}),
	})
	.openapi('TxSyncQuarantineEntry');

export const getTxSyncQuarantineSchemaOutput = z.object({
	Quarantine: z.array(txSyncQuarantineEntrySchema),
});

/**
 * Lists transactions the sync scanner could not apply.
 *
 * These are the transactions the checkpoint has advanced past. Anything sitting
 * here is chain state the database has NOT caught up with, so a non-empty
 * pending list means some request is running on stale information.
 */
export const queryTxSyncQuarantineGet = adminAuthenticatedEndpointFactory.build({
	method: 'get',
	input: getTxSyncQuarantineSchemaInput,
	output: getTxSyncQuarantineSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof getTxSyncQuarantineSchemaInput>; ctx: AuthContext }) => {
		if (input.network != null) {
			await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, input.network);
		}

		const status = input.status ?? 'Pending';
		const statusFilter =
			status === 'Pending'
				? { resolvedAt: null, needsOperator: false }
				: status === 'NeedsOperator'
					? { resolvedAt: null, needsOperator: true }
					: status === 'Resolved'
						? { resolvedAt: { not: null } }
						: {};

		const entries = await prisma.txSyncQuarantine.findMany({
			where: {
				...statusFilter,
				...(input.paymentSourceId != null ? { paymentSourceId: input.paymentSourceId } : {}),
				PaymentSource: {
					// Never leak entries from a network this key may not see.
					network: input.network ?? { in: ctx.networkLimit },
					deletedAt: null,
				},
			},
			orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
			take: input.take ?? 25,
			cursor: input.cursorId != null ? { id: input.cursorId } : undefined,
			include: {
				PaymentSource: { select: { id: true, network: true, smartContractAddress: true } },
			},
		});

		return { Quarantine: entries };
	},
});

export const retryTxSyncQuarantineSchemaInput = z.object({
	id: z.string().describe('The quarantine entry to retry'),
});

export const retryTxSyncQuarantineSchemaOutput = txSyncQuarantineEntrySchema;

/**
 * Schedules an immediate retry, clearing any operator flag.
 *
 * Does not perform the retry inline — the reconciler owns that path, and having
 * two implementations of "apply a transaction" is exactly the drift this whole
 * change is trying to avoid.
 */
export const retryTxSyncQuarantinePost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: retryTxSyncQuarantineSchemaInput,
	output: retryTxSyncQuarantineSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof retryTxSyncQuarantineSchemaInput>; ctx: AuthContext }) => {
		const existing = await prisma.txSyncQuarantine.findUnique({
			where: { id: input.id },
			include: { PaymentSource: { select: { id: true, network: true, smartContractAddress: true } } },
		});
		if (existing == null) {
			throw createHttpError(404, 'Quarantine entry not found');
		}
		await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, existing.PaymentSource.network);

		if (existing.resolvedAt != null) {
			throw createHttpError(400, 'Quarantine entry is already resolved');
		}

		const updated = await prisma.txSyncQuarantine.update({
			where: { id: input.id },
			data: { nextRetryAt: new Date(), needsOperator: false, attempts: 0 },
			include: { PaymentSource: { select: { id: true, network: true, smartContractAddress: true } } },
		});

		logger.info('Quarantine entry re-queued for immediate retry', { id: input.id, txHash: existing.txHash });
		return updated;
	},
});

export const deleteTxSyncQuarantineSchemaInput = z.object({
	id: z.string().describe('The quarantine entry to delete'),
});

export const deleteTxSyncQuarantineSchemaOutput = z.object({
	id: z.string(),
	txHash: z.string(),
});

/**
 * Permanently removes a quarantine entry.
 *
 * Deleting does NOT apply the transaction — the database stays behind the chain
 * for whatever that transaction would have changed. It exists for entries that
 * are genuinely irrelevant (a transaction belonging to another system, an entry
 * already repaired by hand). To acknowledge one without applying it, prefer
 * leaving it resolved by the reconciler so the audit trail survives.
 */
export const deleteTxSyncQuarantineDelete = adminAuthenticatedEndpointFactory.build({
	method: 'delete',
	input: deleteTxSyncQuarantineSchemaInput,
	output: deleteTxSyncQuarantineSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof deleteTxSyncQuarantineSchemaInput>; ctx: AuthContext }) => {
		const existing = await prisma.txSyncQuarantine.findUnique({
			where: { id: input.id },
			include: { PaymentSource: { select: { network: true } } },
		});
		if (existing == null) {
			throw createHttpError(404, 'Quarantine entry not found');
		}
		await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, existing.PaymentSource.network);

		await prisma.txSyncQuarantine.delete({ where: { id: input.id } });

		logger.warn('Quarantine entry deleted without being applied', {
			id: input.id,
			txHash: existing.txHash,
			reason: existing.reason,
			resolved: existing.resolvedAt != null,
		});

		return { id: existing.id, txHash: existing.txHash };
	},
});
