/**
 * What a head has actually done, in order.
 *
 * The head record carries three hashes — Init, Close, Fanout — and nothing else,
 * so the whole middle of a head's life was invisible: every in-head payment,
 * every top-up commit, every attempt that failed. An operator asking "did that
 * payment go through the head or over L1?" had to read the payment's own record
 * and infer it, and an operator asking "what has this head done at all?" had no
 * answer available.
 *
 * Its own file rather than another export in index.ts, which is long past the
 * point where anything new should be added to it.
 */

import createHttpError from 'http-errors';
import { adminAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { prisma } from '@masumi/payment-core/db';
import { z } from '@masumi/payment-core/zod';
import { TransactionLayer, TransactionStatus } from '@/generated/prisma/client';

export const headTransactionSchema = z.object({
	id: z.string(),
	createdAt: z.date(),
	txHash: z
		.string()
		.nullable()
		.describe('Null while a transaction is built but not yet broadcast; intendedTxHash names it in the meantime'),
	intendedTxHash: z.string().nullable(),
	status: z.nativeEnum(TransactionStatus),
	layer: z.nativeEnum(TransactionLayer).describe('L1 for on-chain, L2 for inside the head'),
	confirmations: z.number().nullable(),
	/** Lovelace, as a string: fees are BigInt and JSON has no such thing. */
	fees: z.string().nullable(),
	blockTime: z.number().nullable(),
	lastCheckedAt: z.date().nullable(),
});

export const listHeadTransactionsInput = z.object({
	headId: z.string().min(1).describe('The Hydra head whose transactions to list'),
	cursorId: z.string().optional().describe('Cursor ID for pagination'),
	limit: z.coerce.number().int().min(1).max(100).default(25).describe('Number of results'),
});

export const listHeadTransactionsOutput = z.object({
	transactions: z.array(headTransactionSchema),
});

export const listHeadTransactionsGet = adminAuthenticatedEndpointFactory.build({
	method: 'get',
	input: listHeadTransactionsInput,
	output: listHeadTransactionsOutput,
	handler: async ({ input }) => {
		const head = await prisma.hydraHead.findUnique({ where: { id: input.headId }, select: { id: true } });
		if (!head) {
			throw createHttpError(404, 'Hydra head not found');
		}

		const transactions = await prisma.transaction.findMany({
			where: { hydraHeadId: input.headId },
			// Newest first: the reason anyone opens this list is something that
			// just happened, not something from last week.
			orderBy: { createdAt: 'desc' },
			take: input.limit,
			cursor: input.cursorId ? { id: input.cursorId } : undefined,
			select: {
				id: true,
				createdAt: true,
				txHash: true,
				intendedTxHash: true,
				status: true,
				layer: true,
				confirmations: true,
				fees: true,
				blockTime: true,
				lastCheckedAt: true,
			},
		});

		return {
			transactions: transactions.map((transaction) => ({
				...transaction,
				fees: transaction.fees === null ? null : transaction.fees.toString(),
			})),
		};
	},
});
