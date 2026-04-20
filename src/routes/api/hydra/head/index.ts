import { adminAuthenticatedEndpointFactory } from '@/utils/security/auth/admin-authenticated';
import { z } from '@/utils/zod-openapi';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import { HydraHeadStatus, HydraErrorType } from '@/generated/prisma/client';
import { getHydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';
import { logger } from '@/utils/logger';
import { toPrismaJsonValue } from '@/utils/json-value';

// --- Shared schemas ---

const localParticipantSchema = z.object({
	id: z.string(),
	createdAt: z.string(),
	walletId: z.string(),
	nodeUrl: z.string(),
	nodeHttpUrl: z.string(),
	hasCommitted: z.boolean(),
	commitTxHash: z.string().nullable(),
});

const remoteParticipantSchema = z.object({
	id: z.string(),
	createdAt: z.string(),
	walletId: z.string(),
	nodeUrl: z.string(),
	nodeHttpUrl: z.string(),
	hasCommitted: z.boolean(),
	commitTxHash: z.string().nullable(),
	hydraVerificationKeyId: z.string(),
});

const hydraHeadSchema = z
	.object({
		id: z.string(),
		createdAt: z.string(),
		updatedAt: z.string(),
		hydraRelationId: z.string(),
		headIdentifier: z.string().nullable(),
		status: z.nativeEnum(HydraHeadStatus),
		contestationPeriod: z.string(),
		isEnabled: z.boolean(),
		openedAt: z.string().nullable(),
		closedAt: z.string().nullable(),
		finalizedAt: z.string().nullable(),
		contestationDeadline: z.string().nullable(),
		latestActivityAt: z.string().nullable(),
		latestSnapshotNumber: z.string(),
		initTxHash: z.string().nullable(),
		closeTxHash: z.string().nullable(),
		fanoutTxHash: z.string().nullable(),
		LocalParticipant: localParticipantSchema.nullable().optional(),
		RemoteParticipants: z.array(remoteParticipantSchema).optional(),
		_count: z
			.object({
				Errors: z.number(),
				Transactions: z.number(),
			})
			.optional(),
	})
	.openapi('HydraHead');

// --- GET: list or get by ID ---

const getHeadSchemaInput = z.object({
	id: z.string().optional().describe('Get a single head by ID'),
	relationId: z.string().optional().describe('Filter by HydraRelation ID'),
	status: z.nativeEnum(HydraHeadStatus).optional().describe('Filter by head status'),
	isEnabled: z
		.string()
		.optional()
		.transform((s) => (s === undefined ? undefined : s.toLowerCase() === 'true'))
		.describe('Filter by isEnabled'),
	cursorId: z.string().optional().describe('Cursor ID for pagination'),
	limit: z.coerce.number().min(1).max(100).default(25).describe('Number of results'),
});

const getHeadSchemaOutput = z.object({
	heads: z.array(hydraHeadSchema),
});

const headInclude = {
	LocalParticipant: {
		select: {
			id: true,
			createdAt: true,
			walletId: true,
			nodeUrl: true,
			nodeHttpUrl: true,
			hasCommitted: true,
			commitTxHash: true,
		},
	},
	RemoteParticipants: {
		select: {
			id: true,
			createdAt: true,
			walletId: true,
			nodeUrl: true,
			nodeHttpUrl: true,
			hasCommitted: true,
			commitTxHash: true,
			hydraVerificationKeyId: true,
		},
	},
	_count: { select: { Errors: true, Transactions: true } },
} as const;

export const getOrListHeadsGet = adminAuthenticatedEndpointFactory.build({
	method: 'get',
	input: getHeadSchemaInput,
	output: getHeadSchemaOutput,
	handler: async ({ input }) => {
		if (input.id) {
			const head = await prisma.hydraHead.findUnique({
				where: { id: input.id },
				include: headInclude,
			});

			if (!head) {
				throw createHttpError(404, 'Hydra head not found');
			}

			return { heads: [toPrismaJsonValue(head)] };
		}

		const heads = await prisma.hydraHead.findMany({
			where: {
				...(input.relationId ? { hydraRelationId: input.relationId } : {}),
				...(input.status ? { status: input.status } : {}),
				...(input.isEnabled !== undefined ? { isEnabled: input.isEnabled } : {}),
			},
			include: headInclude,
			orderBy: { createdAt: 'desc' },
			take: input.limit,
			cursor: input.cursorId ? { id: input.cursorId } : undefined,
			...(input.cursorId ? { skip: 1 } : {}),
		});

		return { heads: heads.map(toPrismaJsonValue) };
	},
});

// --- POST: create head (links pre-existing participants) ---

const createHeadSchemaInput = z.object({
	hydraRelationId: z.string().min(1).describe('The HydraRelation this head belongs to'),
	contestationPeriod: z.coerce.number().int().min(1).default(86400).describe('Contestation period in seconds'),
	localParticipantId: z.string().min(1).describe('ID of a pre-existing HydraLocalParticipant'),
	remoteParticipantIds: z
		.array(z.string().min(1))
		.min(1)
		.max(9)
		.describe('IDs of pre-existing HydraRemoteParticipants'),
});

const createHeadSchemaOutput = hydraHeadSchema;

export const createHeadPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: createHeadSchemaInput,
	output: createHeadSchemaOutput,
	handler: async ({ input }) => {
		const relation = await prisma.hydraRelation.findUnique({
			where: { id: input.hydraRelationId },
		});
		if (!relation) {
			throw createHttpError(404, 'Hydra relation not found');
		}

		const localParticipant = await prisma.hydraLocalParticipant.findUnique({
			where: { id: input.localParticipantId },
		});
		if (!localParticipant) {
			throw createHttpError(404, `HydraLocalParticipant ${input.localParticipantId} not found`);
		}
		if (localParticipant.hydraHeadId !== null) {
			throw createHttpError(409, 'Local participant is already assigned to a head');
		}

		const uniqueRemoteIds = new Set(input.remoteParticipantIds);
		if (uniqueRemoteIds.size !== input.remoteParticipantIds.length) {
			throw createHttpError(400, 'Duplicate IDs in remoteParticipantIds');
		}

		const remoteParticipants = await prisma.hydraRemoteParticipant.findMany({
			where: { id: { in: input.remoteParticipantIds } },
		});
		if (remoteParticipants.length !== input.remoteParticipantIds.length) {
			const foundIds = new Set(remoteParticipants.map((rp) => rp.id));
			const missing = input.remoteParticipantIds.filter((id) => !foundIds.has(id));
			throw createHttpError(404, `HydraRemoteParticipant(s) not found: ${missing.join(', ')}`);
		}

		const alreadyAssigned = remoteParticipants.filter((rp) => rp.hydraHeadId !== null);
		if (alreadyAssigned.length > 0) {
			throw createHttpError(
				409,
				`Remote participant(s) already assigned to a head: ${alreadyAssigned.map((rp) => rp.id).join(', ')}`,
			);
		}

		const head = await prisma.hydraHead.create({
			data: {
				HydraRelation: { connect: { id: input.hydraRelationId } },
				contestationPeriod: BigInt(input.contestationPeriod),
				LocalParticipant: { connect: { id: input.localParticipantId } },
				RemoteParticipants: {
					connect: input.remoteParticipantIds.map((id) => ({ id })),
				},
			},
			include: headInclude,
		});

		return toPrismaJsonValue(head);
	},
});

// --- PATCH: update isEnabled ---

const updateHeadSchemaInput = z.object({
	id: z.string().min(1).describe('ID of the HydraHead to update'),
	isEnabled: z.boolean().describe('Whether the head should be enabled'),
});

const updateHeadSchemaOutput = hydraHeadSchema;

export const updateHeadPatch = adminAuthenticatedEndpointFactory.build({
	method: 'patch',
	input: updateHeadSchemaInput,
	output: updateHeadSchemaOutput,
	handler: async ({ input }) => {
		const existing = await prisma.hydraHead.findUnique({ where: { id: input.id } });
		if (!existing) {
			throw createHttpError(404, 'Hydra head not found');
		}

		const head = await prisma.hydraHead.update({
			where: { id: input.id },
			data: { isEnabled: input.isEnabled },
			include: headInclude,
		});

		return toPrismaJsonValue(head);
	},
});

// --- GET errors ---

const headErrorSchema = z.object({
	id: z.string(),
	createdAt: z.date(),
	errorType: z.nativeEnum(HydraErrorType),
	errorMessage: z.string(),
	headStatus: z.nativeEnum(HydraHeadStatus),
	clientInput: z.string().nullable(),
	txHash: z.string().nullable(),
	errorAt: z.date(),
});

const listHeadErrorsSchemaInput = z.object({
	headId: z.string().min(1).describe('ID of the HydraHead'),
	cursorId: z.string().optional().describe('Cursor ID for pagination'),
	limit: z.coerce.number().min(1).max(100).default(25).describe('Number of results'),
});

const listHeadErrorsSchemaOutput = z.object({
	errors: z.array(headErrorSchema),
});

export const listHeadErrorsGet = adminAuthenticatedEndpointFactory.build({
	method: 'get',
	input: listHeadErrorsSchemaInput,
	output: listHeadErrorsSchemaOutput,
	handler: async ({ input }) => {
		const head = await prisma.hydraHead.findUnique({ where: { id: input.headId } });
		if (!head) {
			throw createHttpError(404, 'Hydra head not found');
		}

		const errors = await prisma.hydraHeadError.findMany({
			where: { hydraHeadId: input.headId },
			orderBy: { errorAt: 'desc' },
			take: input.limit,
			cursor: input.cursorId ? { id: input.cursorId } : undefined,
			...(input.cursorId ? { skip: 1 } : {}),
		});

		return { errors };
	},
});

// --- Lifecycle: POST init ---

const lifecycleInput = z.object({
	headId: z.string().min(1).describe('ID of the HydraHead'),
});

const lifecycleOutput = z.object({
	headId: z.string(),
	status: z.nativeEnum(HydraHeadStatus),
});

export const initHeadPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: lifecycleInput,
	output: lifecycleOutput,
	handler: async ({ input }) => {
		const head = await prisma.hydraHead.findUnique({
			where: { id: input.headId },
			include: { LocalParticipant: true },
		});

		if (!head) {
			throw createHttpError(404, 'Hydra head not found');
		}

		if (head.status !== HydraHeadStatus.Idle) {
			throw createHttpError(409, `Cannot init: head status is ${head.status}, expected Idle`);
		}

		if (!head.LocalParticipant) {
			throw createHttpError(400, 'Head has no local participant');
		}

		const cm = getHydraConnectionManager();

		try {
			await cm.connect(head);
			const hydraHead = cm.getHead(head.id);
			if (!hydraHead) {
				throw createHttpError(502, 'Failed to connect to Hydra node');
			}

			await hydraHead.init();

			await prisma.hydraHead.update({
				where: { id: head.id },
				data: {
					status: HydraHeadStatus.Initializing,
					latestActivityAt: new Date(),
				},
			});

			logger.info(`[HydraAPI] Head ${head.id} initialized`);
			return { headId: head.id, status: HydraHeadStatus.Initializing };
		} catch (error) {
			await recordHeadError(head.id, head.status, HydraErrorType.CommandFailed, error, 'Init');
			throw error;
		}
	},
});

// --- Lifecycle: POST commit (local participant only) ---

const commitInput = z.object({
	headId: z.string().min(1).describe('ID of the HydraHead'),
});

const commitOutput = z.object({
	headId: z.string(),
	committed: z.boolean(),
	commitTxHash: z.string().nullable(),
});

export const commitHeadPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: commitInput,
	output: commitOutput,
	handler: async ({ input }) => {
		const head = await prisma.hydraHead.findUnique({
			where: { id: input.headId },
			include: { LocalParticipant: true },
		});

		if (!head) {
			throw createHttpError(404, 'Hydra head not found');
		}

		if (head.status !== HydraHeadStatus.Initializing) {
			throw createHttpError(409, `Cannot commit: head status is ${head.status}, expected Initializing`);
		}

		const localParticipant = head.LocalParticipant;
		if (!localParticipant) {
			throw createHttpError(400, 'Head has no local participant');
		}

		if (localParticipant.hasCommitted) {
			throw createHttpError(409, 'Local participant has already committed');
		}

		const cm = getHydraConnectionManager();
		const hydraHead = cm.getHead(head.id);
		if (!hydraHead) {
			throw createHttpError(502, 'No active connection to Hydra head');
		}

		try {
			const commitTx = await hydraHead.commit([], null, localParticipant.walletId);

			await prisma.hydraLocalParticipant.update({
				where: { id: localParticipant.id },
				data: {
					hasCommitted: true,
					commitTxHash: commitTx.cborHex ?? null,
				},
			});

			await prisma.hydraHead.update({
				where: { id: head.id },
				data: { latestActivityAt: new Date() },
			});

			logger.info(`[HydraAPI] Local participant committed to head ${head.id}`);
			return {
				headId: head.id,
				committed: true,
				commitTxHash: commitTx.cborHex ?? null,
			};
		} catch (error) {
			await recordHeadError(head.id, head.status, HydraErrorType.CommandFailed, error, 'Commit');
			throw error;
		}
	},
});

// --- Lifecycle: POST close ---

export const closeHeadPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: lifecycleInput,
	output: lifecycleOutput,
	handler: async ({ input }) => {
		const head = await prisma.hydraHead.findUnique({ where: { id: input.headId } });

		if (!head) {
			throw createHttpError(404, 'Hydra head not found');
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
			await hydraHead.close();

			await prisma.hydraHead.update({
				where: { id: head.id },
				data: {
					status: HydraHeadStatus.Closed,
					closedAt: new Date(),
					latestActivityAt: new Date(),
				},
			});

			logger.info(`[HydraAPI] Head ${head.id} closed`);
			return { headId: head.id, status: HydraHeadStatus.Closed };
		} catch (error) {
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

			await prisma.hydraHead.update({
				where: { id: head.id },
				data: {
					status: HydraHeadStatus.Final,
					finalizedAt: new Date(),
					latestActivityAt: new Date(),
				},
			});

			cm.disconnect(head.id);

			logger.info(`[HydraAPI] Head ${head.id} finalized via fanout`);
			return { headId: head.id, status: HydraHeadStatus.Final };
		} catch (error) {
			await recordHeadError(head.id, head.status, HydraErrorType.CommandFailed, error, 'Fanout');
			throw error;
		}
	},
});

// --- Helpers ---

async function recordHeadError(
	hydraHeadId: string,
	headStatus: HydraHeadStatus,
	errorType: HydraErrorType,
	error: unknown,
	clientInput: string,
): Promise<void> {
	try {
		const errorMessage = error instanceof Error ? error.message : String(error);
		await prisma.hydraHeadError.create({
			data: {
				hydraHeadId,
				errorType,
				errorMessage,
				headStatus,
				clientInput,
				errorAt: new Date(),
			},
		});
	} catch (logError) {
		logger.error('[HydraAPI] Failed to record head error', { hydraHeadId, logError });
	}
}
