import { adminAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { z } from '@masumi/payment-core/zod';
import { prisma } from '@masumi/payment-core/db';
import createHttpError from 'http-errors';
import { HydraHeadStatus, HydraErrorType, Prisma } from '@/generated/prisma/client';
import { getHydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';
import { logger } from '@masumi/payment-core/logger';
import { resolveTxHash } from '@meshsdk/core';
import { HydraTransactionType, interpretCardanoTxSubmitResult } from '@/lib/hydra';
import { toPrismaJsonValue } from '@/utils/json-value';
import { generateWalletExtended } from '@/utils/generator/wallet-generator';
import { getOwnValue, isPlainObject } from '@masumi/payment-core/object-properties';
import { getBlockfrostInstance } from '@/utils/blockfrost';

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
	HydraRelation: {
		select: {
			network: true,
			LocalHotWallet: {
				select: {
					PaymentSource: {
						select: {
							PaymentSourceConfig: {
								select: {
									rpcProviderApiKey: true,
								},
							},
						},
					},
				},
			},
		},
	},
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

type HydraHeadRecord = Prisma.HydraHeadGetPayload<{ include: typeof headInclude }>;

const HYDRA_HEAD_V2_ASSET_NAME_HEX = '4879647261486561645632';

function serializeHydraHead(head: HydraHeadRecord) {
	const { HydraRelation: _HydraRelation, ...publicHead } = head;
	return toPrismaJsonValue(publicHead);
}

async function enrichHydraHeadLifecycleTxs(head: HydraHeadRecord): Promise<HydraHeadRecord> {
	if (head.initTxHash || !head.headIdentifier) {
		return head;
	}

	const rpcProviderApiKey = head.HydraRelation.LocalHotWallet.PaymentSource.PaymentSourceConfig?.rpcProviderApiKey;
	if (!rpcProviderApiKey) {
		return head;
	}

	const initTxHash = await resolveHydraInitTxHash(head.HydraRelation.network, rpcProviderApiKey, head.headIdentifier);
	if (!initTxHash) {
		return head;
	}

	return prisma.hydraHead.update({
		where: { id: head.id },
		data: { initTxHash },
		include: headInclude,
	});
}

async function resolveHydraInitTxHash(
	network: HydraHeadRecord['HydraRelation']['network'],
	rpcProviderApiKey: string,
	headIdentifier: string,
): Promise<string | null> {
	if (!/^[0-9a-fA-F]{56}$/.test(headIdentifier)) {
		return null;
	}

	const blockfrost = getBlockfrostInstance(network, rpcProviderApiKey);
	const hydraHeadAsset = `${headIdentifier}${HYDRA_HEAD_V2_ASSET_NAME_HEX}`;

	try {
		const transactions = await blockfrost.assetsTransactions(hydraHeadAsset, {
			page: 1,
			order: 'asc',
			count: 1,
		});
		return transactions[0]?.tx_hash ?? null;
	} catch (error) {
		if (
			error instanceof Error &&
			(error.message.includes('404') || error.message.toLowerCase().includes('not found'))
		) {
			return null;
		}

		logger.warn('[HydraAPI] Failed to resolve Hydra init tx hash from Blockfrost', {
			network,
			headIdentifier,
			error,
		});
		return null;
	}
}

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

			const enrichedHead = await enrichHydraHeadLifecycleTxs(head);
			return { heads: [serializeHydraHead(enrichedHead)] };
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

		const enrichedHeads = await Promise.all(heads.map(enrichHydraHeadLifecycleTxs));
		return { heads: enrichedHeads.map(serializeHydraHead) };
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

		return serializeHydraHead(head);
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

		return serializeHydraHead(head);
	},
});

// --- POST: check node reachability/status ---

const checkHeadNodeSchemaInput = z.object({
	nodeHttpUrl: z.string().min(1).describe('HTTP URL for the Hydra node'),
	nodeUrl: z.string().min(1).optional().describe('Optional WebSocket URL for the Hydra node'),
	timeoutMs: z.coerce
		.number()
		.int()
		.min(500)
		.max(15000)
		.default(5000)
		.describe('Maximum probe duration in milliseconds'),
});

const checkHeadNodeSchemaOutput = z.object({
	reachable: z.boolean(),
	protocolParametersOk: z.boolean(),
	websocketReachable: z.boolean(),
	httpStatus: z.number().nullable(),
	status: z.nativeEnum(HydraHeadStatus).nullable(),
	checkedAt: z.string(),
	error: z.string().nullable(),
});

export const checkHeadNodePost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: checkHeadNodeSchemaInput,
	output: checkHeadNodeSchemaOutput,
	handler: async ({ input }) => {
		const httpProbe = await probeHydraHttpNode(input.nodeHttpUrl, input.timeoutMs);
		const websocketProbe = input.nodeUrl
			? await probeHydraWebSocketNode(input.nodeUrl, input.timeoutMs)
			: { websocketReachable: false, status: null, error: null };

		const errors = [httpProbe.error, websocketProbe.error].filter((error): error is string => Boolean(error));

		return {
			reachable: httpProbe.protocolParametersOk || websocketProbe.websocketReachable,
			protocolParametersOk: httpProbe.protocolParametersOk,
			websocketReachable: websocketProbe.websocketReachable,
			httpStatus: httpProbe.httpStatus,
			status: websocketProbe.status,
			checkedAt: new Date().toISOString(),
			error: errors.length > 0 ? errors.join('; ') : null,
		};
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

			try {
				await hydraHead.init();
			} catch (initError) {
				// A bounded init that never observed HeadIsInitializing means the
				// hydra-node posted the InitTx but the chain backend (Blockfrost)
				// silently dropped it — the node does not resubmit, so it is wedged.
				// Leave the head Idle (no state regression) and return an actionable
				// 504 so the operator retries rather than seeing a generic hang/500.
				await recordHeadError(head.id, head.status, HydraErrorType.CommandFailed, initError, 'Init');
				throw createHttpError(
					504,
					initError instanceof Error ? initError.message : 'Init did not confirm on-chain in time',
				);
			}

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
			if (createHttpError.isHttpError(error)) {
				throw error;
			}
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

		if (head.status !== HydraHeadStatus.Initializing && head.status !== HydraHeadStatus.Open) {
			throw createHttpError(409, `Cannot commit: head status is ${head.status}, expected Initializing or Open`);
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
			// Load the local participant's hot wallet + its L1 provider so we can
			// fund the head with REAL UTxOs. A commit must spend the committing
			// wallet's L1 UTxOs and be signed + submitted to L1 (the hydra-node only
			// returns an unsigned draft). An empty commit opens a head with no
			// funds, which no escrow lock can ever spend.
			const hotWallet = await prisma.hotWallet.findUniqueOrThrow({
				where: { id: localParticipant.walletId },
				include: { Secret: true, PaymentSource: { include: { PaymentSourceConfig: true } } },
			});
			const rpcProviderApiKey = hotWallet.PaymentSource.PaymentSourceConfig?.rpcProviderApiKey;
			if (!rpcProviderApiKey) {
				throw createHttpError(500, 'Payment source has no RPC provider configured for the L1 commit');
			}

			const { wallet, utxos } = await generateWalletExtended(
				hotWallet.PaymentSource.network,
				rpcProviderApiKey,
				hotWallet.Secret.encryptedMnemonic,
			);
			if (utxos.length === 0) {
				throw createHttpError(400, 'Local participant wallet has no L1 UTxOs available to commit');
			}

			// Commit all of the wallet's L1 UTxOs into the head (funds the buyer's
			// in-head balance that the escrow lock will later spend). Committing the
			// full balance is the simplest correct funding model for a dedicated
			// head wallet; selecting a subset is a future optimization.
			const commitDraftTx = await hydraHead.commit(utxos, null, localParticipant.walletId);

			// hydra-node returns an UNSIGNED commit tx spending the wallet's L1
			// UTxOs. Sign (partial — the draft may already carry node witnesses).
			const signedCommitTx = await wallet.signTx(commitDraftTx.cborHex, true);
			// resolveTxHash is typed `any` upstream; coerce to a concrete string.
			const commitTxHash: string = String(resolveTxHash(signedCommitTx));

			// Submit the signed commit tx to L1 through the hydra-node's own
			// `/cardano-transaction` endpoint rather than the wallet's L1 provider.
			// The hydra-node is always connected to the exact L1 the head lives on,
			// so this works in every environment — including a local devnet whose
			// network magic Blockfrost cannot see (the L1-provider mismatch that
			// previously made a real commit impossible on devnet). The node then
			// observes the commit on-chain and moves the funds into the head.
			const submitResult = await hydraHead.cardanoTransaction(
				{
					type: HydraTransactionType.TxConwayEra,
					description: '',
					cborHex: signedCommitTx,
				},
				localParticipant.walletId,
			);

			// hydra-node replies `{ tag: 'TransactionSubmitted' }` on success or
			// `{ tag: 'FailedToPostTx', failureReason }` on rejection. Fail loudly so
			// the caller knows the commit never reached L1.
			const interpreted = interpretCardanoTxSubmitResult(submitResult);
			if (!interpreted.ok) {
				throw createHttpError(502, `Hydra node rejected the commit tx submission: ${interpreted.reason}`);
			}

			await prisma.hydraLocalParticipant.update({
				where: { id: localParticipant.id },
				data: {
					hasCommitted: true,
					commitTxHash,
				},
			});

			await prisma.hydraHead.update({
				where: { id: head.id },
				data: { latestActivityAt: new Date() },
			});

			logger.info(`[HydraAPI] Local participant committed to head ${head.id}`, { commitTxHash });
			return {
				headId: head.id,
				committed: true,
				commitTxHash,
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

function buildProtocolParametersUrl(nodeHttpUrl: string): string {
	const baseUrl = nodeHttpUrl.replace(/\/+$/, '');
	return `${baseUrl}/protocol-parameters`;
}

function appendHistoryNo(nodeUrl: string): string {
	const separator = nodeUrl.includes('?') ? '&' : '?';
	return `${nodeUrl}${separator}history=no`;
}

function getErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

async function probeHydraHttpNode(
	nodeHttpUrl: string,
	timeoutMs: number,
): Promise<{ protocolParametersOk: boolean; httpStatus: number | null; error: string | null }> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const response = await fetch(buildProtocolParametersUrl(nodeHttpUrl), {
			method: 'GET',
			signal: controller.signal,
		});

		return {
			protocolParametersOk: response.ok,
			httpStatus: response.status,
			error: response.ok ? null : `Protocol parameters returned HTTP ${response.status}`,
		};
	} catch (error) {
		return {
			protocolParametersOk: false,
			httpStatus: null,
			error: `Protocol parameters probe failed: ${getErrorMessage(error)}`,
		};
	} finally {
		clearTimeout(timeout);
	}
}

function isHydraHeadStatus(value: unknown): value is HydraHeadStatus {
	return typeof value === 'string' && Object.values(HydraHeadStatus).includes(value as HydraHeadStatus);
}

function parseHydraStatusMessage(value: unknown): HydraHeadStatus | null {
	if (!isPlainObject(value)) {
		return null;
	}

	const headStatus = getOwnValue(value, 'headStatus');
	if (isHydraHeadStatus(headStatus)) {
		return headStatus;
	}

	const tag = getOwnValue(value, 'tag');
	if (tag === 'HeadIsInitializing') return HydraHeadStatus.Initializing;
	if (tag === 'HeadIsOpen') return HydraHeadStatus.Open;
	if (tag === 'HeadIsClosed') return HydraHeadStatus.Closed;
	if (tag === 'ReadyToFanout') return HydraHeadStatus.FanoutPossible;
	if (tag === 'HeadIsFinalized') return HydraHeadStatus.Final;

	return null;
}

function normalizeWebSocketData(data: unknown): string | null {
	if (typeof data === 'string') {
		return data;
	}
	if (data instanceof ArrayBuffer) {
		return Buffer.from(data).toString('utf8');
	}
	if (ArrayBuffer.isView(data)) {
		return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
	}
	return null;
}

async function probeHydraWebSocketNode(
	nodeUrl: string,
	timeoutMs: number,
): Promise<{ websocketReachable: boolean; status: HydraHeadStatus | null; error: string | null }> {
	if (!globalThis.WebSocket) {
		return {
			websocketReachable: false,
			status: null,
			error: 'WebSocket is not available in this runtime',
		};
	}

	return new Promise((resolve) => {
		let websocket: WebSocket | null = null;
		let didOpen = false;
		let settled = false;

		const timeout = setTimeout(() => {
			finish({
				websocketReachable: didOpen,
				status: null,
				error: didOpen ? 'Timed out waiting for Hydra status' : 'WebSocket probe timed out',
			});
		}, timeoutMs);

		function finish(result: { websocketReachable: boolean; status: HydraHeadStatus | null; error: string | null }) {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timeout);
			try {
				websocket?.close();
			} catch {
				// Closing a failed probe is best-effort only.
			}
			resolve(result);
		}

		try {
			websocket = new WebSocket(appendHistoryNo(nodeUrl));
			websocket.addEventListener('open', () => {
				didOpen = true;
			});
			websocket.addEventListener('message', (event) => {
				const rawMessage = normalizeWebSocketData(event.data);
				if (!rawMessage) {
					return;
				}

				try {
					const parsed = JSON.parse(rawMessage) as unknown;
					const status = parseHydraStatusMessage(parsed);
					finish({ websocketReachable: true, status, error: null });
				} catch (error) {
					finish({
						websocketReachable: true,
						status: null,
						error: `Hydra status message was not valid JSON: ${getErrorMessage(error)}`,
					});
				}
			});
			websocket.addEventListener('error', () => {
				finish({
					websocketReachable: didOpen,
					status: null,
					error: 'WebSocket probe failed',
				});
			});
		} catch (error) {
			finish({
				websocketReachable: false,
				status: null,
				error: `WebSocket probe failed: ${getErrorMessage(error)}`,
			});
		}
	});
}
