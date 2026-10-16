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
 * The list merges three sources: ledger rows, the head's own deposits, and the
 * transfers that fuel its node. A Prisma cursor walks one table, so page two
 * would skip rows from two sources and repeat rows from the third. Instead the
 * cursor id is resolved to its (createdAt, id) position once, and every source
 * is read from that position. See newest-first-cursor.ts.
 *
 * Its own file rather than another export in index.ts, which is long past the
 * point where anything new should be added to it.
 */

import createHttpError from 'http-errors';
import { adminAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { z } from '@masumi/payment-core/zod';
import { TransactionLayer, TransactionStatus } from '@/generated/prisma/client';
import { nodeCardanoAddress } from '@/services/hydra-node-funding/node-address';
import {
	atOrAfter,
	compareNewestFirst,
	newestFirstOrder,
	type NewestFirstPosition,
} from '@/routes/api/hydra/head/newest-first-cursor';

export const headTransactionSchema = z.object({
	id: z.string(),
	kind: z
		.enum(['Ledger', 'Deposit', 'NodeFunding'])
		.describe(
			'Ledger is a payment this head carried. Deposit is money being moved into the head. NodeFunding is ADA sent to the node key that pays this head\u2019s on-chain fees.',
		),
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
	lovelace: z.string().nullable().describe('The amount moved, for deposits and node funding. Null for ledger rows.'),
	blockTime: z.number().nullable(),
	lastCheckedAt: z.date().nullable(),
});

export const listHeadTransactionsInput = z.object({
	headId: z.string().min(1).describe('The Hydra head whose transactions to list'),
	cursorId: z
		.string()
		.optional()
		.describe(
			'Inclusive cursor: the id of the last row already seen, of any kind. It is returned again first. An id this head does not list returns an empty page.',
		),
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
		const head = await prisma.hydraHead.findUnique({
			where: { id: input.headId },
			select: {
				id: true,
				HydraRelation: { select: { network: true } },
				LocalParticipant: { select: { cardanoVkey: true } },
			},
		});
		if (!head) {
			throw createHttpError(404, 'Hydra head not found');
		}

		// Matched by address rather than by relation: a transfer is to a node key,
		// and only this head's participant holds that key.
		// A key hash that cannot be turned into an address is a broken participant,
		// not a reason to fail the whole history: the ledger rows and deposits below
		// are still worth returning.
		let nodeAddress: string | null = null;
		if (head.LocalParticipant !== null) {
			try {
				nodeAddress = nodeCardanoAddress(head.LocalParticipant.cardanoVkey, head.HydraRelation.network);
			} catch (error) {
				logger.warn(
					`hydra: head ${input.headId} has an unusable node key, so its funding transfers are omitted: ${(error as Error).message}`,
				);
			}
		}
		// The cursor names a row in one of the three sources. Each lookup is scoped
		// to this head, so an id from another head reads as unknown rather than
		// paging this head from a position it never listed.
		let position: NewestFirstPosition | null = null;
		if (input.cursorId !== undefined) {
			const select = { id: true, createdAt: true } as const;
			const [ledgerRow, depositRow, fundingRow] = await Promise.all([
				prisma.transaction.findFirst({ where: { id: input.cursorId, hydraHeadId: input.headId }, select }),
				prisma.hydraTopup.findFirst({ where: { id: input.cursorId, hydraHeadId: input.headId }, select }),
				nodeAddress === null
					? null
					: prisma.walletFundTransfer.findFirst({ where: { id: input.cursorId, toAddress: nodeAddress }, select }),
			]);
			position = ledgerRow ?? depositRow ?? fundingRow;
			if (position === null) {
				return { transactions: [] };
			}
		}
		const from = position === null ? {} : atOrAfter(position);

		const transactions = await prisma.transaction.findMany({
			where: { hydraHeadId: input.headId, ...from },
			// Newest first: the reason anyone opens this list is something that
			// just happened, not something from last week.
			orderBy: newestFirstOrder,
			take: input.limit,
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

		// Deposits and node funding are money moving on this head's behalf, and
		// neither is a Transaction row: a deposit is tracked by the head's own
		// top-up record, and node funding is a wallet transfer to an address the
		// head does not reference. Read separately and merged, because an operator
		// asking what this head has done means all three, and the pending ones
		// most of all.
		const deposits = await prisma.hydraTopup.findMany({
			where: { hydraHeadId: input.headId, ...from },
			orderBy: newestFirstOrder,
			take: input.limit,
			select: {
				id: true,
				createdAt: true,
				depositTxHash: true,
				splitTxHash: true,
				status: true,
				committedLovelace: true,
			},
		});

		const funding =
			nodeAddress === null
				? []
				: await prisma.walletFundTransfer.findMany({
						where: { toAddress: nodeAddress, ...from },
						orderBy: newestFirstOrder,
						take: input.limit,
						select: { id: true, createdAt: true, txHash: true, status: true, lovelaceAmount: true },
					});

		const merged = [
			...transactions.map((transaction) => ({
				id: transaction.id,
				kind: 'Ledger' as const,
				createdAt: transaction.createdAt,
				txHash: transaction.txHash,
				intendedTxHash: transaction.intendedTxHash,
				status: transaction.status,
				layer: transaction.layer,
				confirmations: transaction.confirmations,
				fees: transaction.fees === null ? null : transaction.fees.toString(),
				lovelace: null as string | null,
				blockTime: transaction.blockTime,
				lastCheckedAt: transaction.lastCheckedAt,
			})),
			...deposits.map((deposit) => ({
				id: deposit.id,
				kind: 'Deposit' as const,
				createdAt: deposit.createdAt,
				// A deposit still being prepared has no deposit transaction, but it does
				// have the split that carved the amount, and that is the one that has
				// already moved the funds.
				txHash: deposit.depositTxHash ?? deposit.splitTxHash,
				intendedTxHash: null,
				// A deposit's states map onto the ledger vocabulary directly. Both
				// terminal successes land on Confirmed: `Absorbed` is the head taking
				// the deposit in and `Recovered` is it coming home, and either way the
				// L1 transaction this row names is on chain and finished with.
				//
				// They used to fall through to Pending, which put a grey "Pending"
				// badge beside the deposits panel's own green "In the head" for the
				// same deposit, and kept the transactions list polling every eight
				// seconds for the life of the dialog, for ever, on any head that had
				// ever absorbed one. Failed carries across as a failure rather than
				// collapsing into Pending, or a deposit that expired unclaimed would
				// show as still on its way.
				status:
					deposit.status === 'Confirmed' || deposit.status === 'Absorbed' || deposit.status === 'Recovered'
						? TransactionStatus.Confirmed
						: deposit.status === 'Failed'
							? TransactionStatus.FailedViaTimeout
							: TransactionStatus.Pending,
				layer: TransactionLayer.L1,
				confirmations: null,
				fees: null,
				// Zero is a placeholder here, not a total: a whole-UTxO top-up commits
				// whatever the selection holds and the amount is unknown until the
				// deposit is built.
				lovelace: deposit.committedLovelace === 0n ? null : deposit.committedLovelace.toString(),
				blockTime: null,
				lastCheckedAt: null,
			})),
			...funding.map((transfer) => ({
				id: transfer.id,
				kind: 'NodeFunding' as const,
				createdAt: transfer.createdAt,
				txHash: transfer.txHash,
				intendedTxHash: null,
				status: transfer.status,
				layer: TransactionLayer.L1,
				confirmations: null,
				fees: null,
				lovelace: transfer.lovelaceAmount.toString(),
				blockTime: null,
				lastCheckedAt: null,
			})),
		].sort(compareNewestFirst);

		return { transactions: merged.slice(0, input.limit) };
	},
});
