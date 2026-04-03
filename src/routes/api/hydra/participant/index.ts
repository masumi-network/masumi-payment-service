import { adminAuthenticatedEndpointFactory } from '@/utils/security/auth/admin-authenticated';
import { z } from '@/utils/zod-openapi';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import { HydraHeadStatus } from '@/generated/prisma/client';
import { encrypt } from '@/utils/security/encryption';

// --- Shared schemas ---

const localParticipantSchema = z
	.object({
		id: z.string(),
		createdAt: z.date(),
		updatedAt: z.date(),
		hydraHeadId: z.string().nullable(),
		walletId: z.string(),
		nodeUrl: z.string(),
		nodeHttpUrl: z.string(),
		hasCommitted: z.boolean(),
		commitTxHash: z.string().nullable(),
	})
	.openapi('HydraLocalParticipant');

const remoteParticipantSchema = z
	.object({
		id: z.string(),
		createdAt: z.date(),
		updatedAt: z.date(),
		hydraHeadId: z.string().nullable(),
		walletId: z.string(),
		nodeUrl: z.string(),
		nodeHttpUrl: z.string(),
		hasCommitted: z.boolean(),
		commitTxHash: z.string().nullable(),
		hydraVerificationKeyId: z.string(),
	})
	.openapi('HydraRemoteParticipant');

// ============================================================
// LOCAL PARTICIPANT ENDPOINTS
// ============================================================

// --- POST: create local participant ---

const createLocalParticipantInput = z.object({
	walletId: z.string().min(1).describe('HotWallet ID for the local participant'),
	nodeUrl: z.string().min(1).describe('WebSocket URL for the local Hydra node'),
	nodeHttpUrl: z.string().min(1).describe('HTTP URL for the local Hydra node'),
	hydraSK: z.string().min(1).describe('Hydra signing key (will be encrypted)'),
});

const createLocalParticipantOutput = z.object({
	participant: localParticipantSchema,
});

export const createLocalParticipantPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: createLocalParticipantInput,
	output: createLocalParticipantOutput,
	handler: async ({ input }) => {
		const wallet = await prisma.hotWallet.findFirst({
			where: { id: input.walletId, deletedAt: null },
		});
		if (!wallet) {
			throw createHttpError(404, `HotWallet ${input.walletId} not found`);
		}

		const participant = await prisma.hydraLocalParticipant.create({
			data: {
				Wallet: { connect: { id: input.walletId } },
				nodeUrl: input.nodeUrl,
				nodeHttpUrl: input.nodeHttpUrl,
				HydraSecretKey: {
					create: {
						hydraSK: encrypt(input.hydraSK),
					},
				},
			},
		});

		return { participant };
	},
});

// --- GET: list or get local participants ---

const getLocalParticipantInput = z.object({
	id: z.string().optional().describe('Get a single participant by ID'),
	walletId: z.string().optional().describe('Filter by HotWallet ID'),
	unassigned: z
		.string()
		.optional()
		.transform((s) => (s === undefined ? undefined : s.toLowerCase() === 'true'))
		.describe('Filter to only unassigned participants (no head)'),
	cursorId: z.string().optional().describe('Cursor ID for pagination'),
	limit: z.coerce.number().min(1).max(100).default(25).describe('Number of results'),
});

const getLocalParticipantOutput = z.object({
	participants: z.array(localParticipantSchema),
});

export const getLocalParticipantGet = adminAuthenticatedEndpointFactory.build({
	method: 'get',
	input: getLocalParticipantInput,
	output: getLocalParticipantOutput,
	handler: async ({ input }) => {
		if (input.id) {
			const participant = await prisma.hydraLocalParticipant.findUnique({
				where: { id: input.id },
			});
			if (!participant) {
				throw createHttpError(404, 'Local participant not found');
			}
			return { participants: [participant] };
		}

		const participants = await prisma.hydraLocalParticipant.findMany({
			where: {
				...(input.walletId ? { walletId: input.walletId } : {}),
				...(input.unassigned === true ? { hydraHeadId: null } : {}),
				...(input.unassigned === false ? { hydraHeadId: { not: null } } : {}),
			},
			orderBy: { createdAt: 'desc' },
			take: input.limit,
			cursor: input.cursorId ? { id: input.cursorId } : undefined,
			...(input.cursorId ? { skip: 1 } : {}),
		});

		return { participants };
	},
});

// --- DELETE: delete local participant ---

const NON_FINAL_STATUSES: HydraHeadStatus[] = [
	HydraHeadStatus.Idle,
	HydraHeadStatus.Initializing,
	HydraHeadStatus.Open,
	HydraHeadStatus.Closed,
	HydraHeadStatus.FanoutPossible,
];

const deleteLocalParticipantInput = z.object({
	id: z.string().min(1).describe('ID of the local participant to delete'),
});

const deleteLocalParticipantOutput = z.object({
	id: z.string(),
	deleted: z.boolean(),
});

export const deleteLocalParticipantDelete = adminAuthenticatedEndpointFactory.build({
	method: 'delete',
	input: deleteLocalParticipantInput,
	output: deleteLocalParticipantOutput,
	handler: async ({ input }) => {
		const participant = await prisma.hydraLocalParticipant.findUnique({
			where: { id: input.id },
			include: {
				HydraHead: { select: { id: true, status: true } },
			},
		});

		if (!participant) {
			throw createHttpError(404, 'Local participant not found');
		}

		if (participant.HydraHead && NON_FINAL_STATUSES.includes(participant.HydraHead.status)) {
			throw createHttpError(409, 'Cannot delete: participant is assigned to a non-final head');
		}

		await prisma.hydraLocalParticipant.delete({ where: { id: input.id } });

		return { id: input.id, deleted: true };
	},
});

// ============================================================
// REMOTE PARTICIPANT ENDPOINTS
// ============================================================

// --- POST: create remote participant ---

const createRemoteParticipantInput = z.object({
	walletId: z.string().min(1).describe('WalletBase ID for the remote counterparty'),
	nodeUrl: z.string().min(1).describe('WebSocket URL for the remote Hydra node'),
	nodeHttpUrl: z.string().min(1).describe('HTTP URL for the remote Hydra node'),
	hydraVK: z.string().min(1).describe('Hydra verification key (cborHex)'),
});

const createRemoteParticipantOutput = z.object({
	participant: remoteParticipantSchema,
});

export const createRemoteParticipantPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: createRemoteParticipantInput,
	output: createRemoteParticipantOutput,
	handler: async ({ input }) => {
		const wallet = await prisma.walletBase.findUnique({
			where: { id: input.walletId },
		});
		if (!wallet) {
			throw createHttpError(404, `WalletBase ${input.walletId} not found`);
		}

		const participant = await prisma.hydraRemoteParticipant.create({
			data: {
				Wallet: { connect: { id: input.walletId } },
				nodeUrl: input.nodeUrl,
				nodeHttpUrl: input.nodeHttpUrl,
				HydraVerificationKey: {
					create: { hydraVK: input.hydraVK },
				},
			},
		});

		return { participant };
	},
});

// --- GET: list or get remote participants ---

const getRemoteParticipantInput = z.object({
	id: z.string().optional().describe('Get a single participant by ID'),
	walletId: z.string().optional().describe('Filter by WalletBase ID'),
	unassigned: z
		.string()
		.optional()
		.transform((s) => (s === undefined ? undefined : s.toLowerCase() === 'true'))
		.describe('Filter to only unassigned participants (no head)'),
	cursorId: z.string().optional().describe('Cursor ID for pagination'),
	limit: z.coerce.number().min(1).max(100).default(25).describe('Number of results'),
});

const getRemoteParticipantOutput = z.object({
	participants: z.array(remoteParticipantSchema),
});

export const getRemoteParticipantGet = adminAuthenticatedEndpointFactory.build({
	method: 'get',
	input: getRemoteParticipantInput,
	output: getRemoteParticipantOutput,
	handler: async ({ input }) => {
		if (input.id) {
			const participant = await prisma.hydraRemoteParticipant.findUnique({
				where: { id: input.id },
			});
			if (!participant) {
				throw createHttpError(404, 'Remote participant not found');
			}
			return { participants: [participant] };
		}

		const participants = await prisma.hydraRemoteParticipant.findMany({
			where: {
				...(input.walletId ? { walletId: input.walletId } : {}),
				...(input.unassigned === true ? { hydraHeadId: null } : {}),
				...(input.unassigned === false ? { hydraHeadId: { not: null } } : {}),
			},
			orderBy: { createdAt: 'desc' },
			take: input.limit,
			cursor: input.cursorId ? { id: input.cursorId } : undefined,
			...(input.cursorId ? { skip: 1 } : {}),
		});

		return { participants };
	},
});

// --- DELETE: delete remote participant ---

const deleteRemoteParticipantInput = z.object({
	id: z.string().min(1).describe('ID of the remote participant to delete'),
});

const deleteRemoteParticipantOutput = z.object({
	id: z.string(),
	deleted: z.boolean(),
});

export const deleteRemoteParticipantDelete = adminAuthenticatedEndpointFactory.build({
	method: 'delete',
	input: deleteRemoteParticipantInput,
	output: deleteRemoteParticipantOutput,
	handler: async ({ input }) => {
		const participant = await prisma.hydraRemoteParticipant.findUnique({
			where: { id: input.id },
			include: {
				HydraHead: { select: { id: true, status: true } },
			},
		});

		if (!participant) {
			throw createHttpError(404, 'Remote participant not found');
		}

		if (participant.HydraHead && NON_FINAL_STATUSES.includes(participant.HydraHead.status)) {
			throw createHttpError(409, 'Cannot delete: participant is assigned to a non-final head');
		}

		await prisma.hydraRemoteParticipant.delete({ where: { id: input.id } });

		return { id: input.id, deleted: true };
	},
});
