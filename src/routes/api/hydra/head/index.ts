import { adminAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { CONFIG } from '@masumi/payment-core/config';
import { z } from '@masumi/payment-core/zod';
import { prisma } from '@masumi/payment-core/db';
import createHttpError from 'http-errors';
import WebSocket, { type RawData } from 'ws';
import {
	HydraHeadStatus,
	HydraErrorType,
	Network,
	Prisma,
	TransactionLayer,
	TransactionStatus,
} from '@/generated/prisma/client';
import { getHydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';
import { getOwnInHeadBalance } from '@/services/hydra-connection-manager/hydra-head-balance';
import { logger } from '@masumi/payment-core/logger';
import {
	assertHydraCommitSignedBody,
	assertCommitDraftInputsAreNodeFunded,
	buildHydraHttpEndpoint,
	deriveHydraVerificationKeyCborHex,
	HydraCommitInputSafetyError,
	getHydraPlaintextHosts,
	HydraHeadInitObservationError,
	HydraTransactionType,
	HydraTransportError,
	interpretCardanoTxSubmitResult,
	MAX_HYDRA_WS_FRAME_BYTES,
	normalizeHydraVerificationKeyCborHex,
	parseHydraWebSocketProbeFrame,
	readHydraCommitDraftInputReferences,
	resolveHydraDepositScriptHash,
	selectCommitUtxos,
	validateHydraHttpUrl,
	validateHydraCommitDraft,
	validateHydraNodeUrls,
	verifyHydraHeadInitOnChain,
	withHydraHistoryDisabled,
} from '@/lib/hydra';
import { resolvePaymentKeyHash } from '@meshsdk/core';
import { toPrismaJsonValue } from '@/utils/json-value';
import { generateWalletExtended } from '@/utils/generator/wallet-generator';
import { getOwnValue, isPlainObject } from '@masumi/payment-core/object-properties';
import { getBlockfrostInstance } from '@/utils/blockfrost';
import { convertNetwork } from '@/utils/converter/network-convert';
import { resolveHydraL2EvidenceSlotConfig } from '@/utils/hydra/l2-slot-context';
import { withSerializableSlotRetry } from '@masumi/payment-core/serializable-semaphore';
import { isUniqueConstraintError } from '@masumi/payment-core/db-retry';
import {
	HydraCommitReservationConflictError,
	reconcilePendingHydraCommit,
	reserveAndSubmitHydraCommit,
	type HydraCommitReconciliationResult,
} from '@/services/hydra-commit-reconciliation';
import { decrypt } from '@/utils/security/encryption';
import { lookupConfirmedChainTx } from '@/services/shared/chain-tx-lookup';
import { hasUnsettledHydraRequestState, unsettledL2TransactionWhere } from '../deletion-guard';

// --- Shared schemas ---

export const localParticipantSchema = z.object({
	id: z.string(),
	createdAt: z.string(),
	walletId: z.string(),
	nodeUrl: z.string(),
	nodeHttpUrl: z.string(),
	hasCommitted: z.boolean(),
	commitTxHash: z.string().nullable(),
});

export const remoteParticipantSchema = z.object({
	id: z.string(),
	createdAt: z.string(),
	walletId: z.string(),
	nodeUrl: z.string(),
	nodeHttpUrl: z.string(),
	hasCommitted: z.boolean(),
	commitTxHash: z.string().nullable(),
	hydraVerificationKeyId: z.string(),
});

export const hydraHeadSchema = z
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
		reconciliationStalledTxId: z
			.string()
			.nullable()
			.describe('Confirmed in-head tx the ordered replay is stuck on (fail-closed stall); null when replay is healthy'),
		reconciliationStalledReason: z
			.string()
			.nullable()
			.describe('Why replay is stalled: evidence-parse-failed | replay-apply-retry'),
		reconciliationStalledSince: z.string().nullable().describe('When the current stall was first observed'),
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

export const getHeadSchemaInput = z.object({
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

export const getHeadSchemaOutput = z.object({
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

function serializeHydraHead(head: HydraHeadRecord) {
	const { HydraRelation: _HydraRelation, ...publicHead } = head;
	return toPrismaJsonValue(publicHead);
}

const hydraHeadOnChainVerificationSelect = {
	id: true,
	isEnabled: true,
	headIdentifier: true,
	contestationPeriod: true,
	LocalParticipant: {
		select: {
			walletId: true,
			cardanoVkey: true,
			HydraSecretKey: { select: { hydraSK: true } },
		},
	},
	RemoteParticipants: {
		select: {
			walletId: true,
			cardanoVkey: true,
			HydraVerificationKey: { select: { hydraVK: true } },
		},
	},
	HydraRelation: {
		select: {
			network: true,
			localHotWalletId: true,
			remoteWalletId: true,
			LocalHotWallet: {
				select: {
					walletVkey: true,
					deletedAt: true,
					PaymentSource: {
						select: {
							network: true,
							deletedAt: true,
							disableSyncAt: true,
							PaymentSourceConfig: { select: { rpcProviderApiKey: true } },
						},
					},
				},
			},
			RemoteWallet: {
				select: {
					walletVkey: true,
					PaymentSource: {
						select: { network: true, deletedAt: true, disableSyncAt: true },
					},
				},
			},
		},
	},
} as const;

/** Independently bind the DB/node head identity to its Hydra 2.3 InitTx. */
async function verifyPersistedHydraHeadOnChain(
	headId: string,
	options: { allowDisabled?: boolean; persist?: boolean } = {},
): Promise<{ headIdentifier: string; initTxHash: string }> {
	const head = await prisma.hydraHead.findUnique({
		where: { id: headId },
		select: hydraHeadOnChainVerificationSelect,
	});
	if (!head) throw createHttpError(404, 'Hydra head not found');
	if (!head.isEnabled && options.allowDisabled !== true) throw createHttpError(409, 'Hydra head is disabled');
	if (!head.headIdentifier) throw createHttpError(409, 'Hydra head identifier has not been observed');
	if (
		!head.LocalParticipant ||
		head.LocalParticipant.walletId !== head.HydraRelation.localHotWalletId ||
		head.RemoteParticipants.length !== 1 ||
		head.RemoteParticipants[0]?.walletId !== head.HydraRelation.remoteWalletId
	) {
		throw createHttpError(409, 'Hydra head participants no longer match their relation');
	}
	const localPaymentSource = head.HydraRelation.LocalHotWallet.PaymentSource;
	const remotePaymentSource = head.HydraRelation.RemoteWallet.PaymentSource;
	if (
		head.HydraRelation.LocalHotWallet.deletedAt !== null ||
		localPaymentSource.deletedAt !== null ||
		remotePaymentSource.deletedAt !== null ||
		localPaymentSource.disableSyncAt !== null ||
		remotePaymentSource.disableSyncAt !== null
	) {
		throw createHttpError(409, 'Hydra head payment sources must be active and sync-enabled');
	}
	if (
		localPaymentSource.network !== head.HydraRelation.network ||
		remotePaymentSource.network !== head.HydraRelation.network
	) {
		throw createHttpError(409, 'Hydra head participants are on the wrong Cardano network');
	}
	const rpcProviderApiKey = localPaymentSource.PaymentSourceConfig?.rpcProviderApiKey;
	if (!rpcProviderApiKey) throw createHttpError(500, 'Hydra head has no independent L1 observer configured');

	const localVerificationKey = deriveHydraVerificationKeyCborHex(decrypt(head.LocalParticipant.HydraSecretKey.hydraSK));
	const storedRemoteVerificationKey = head.RemoteParticipants[0].HydraVerificationKey.hydraVK;
	let remoteVerificationKey: string;
	try {
		remoteVerificationKey = normalizeHydraVerificationKeyCborHex(storedRemoteVerificationKey);
	} catch (plaintextError) {
		try {
			remoteVerificationKey = normalizeHydraVerificationKeyCborHex(decrypt(storedRemoteVerificationKey));
		} catch {
			throw plaintextError;
		}
	}

	const verified = await verifyHydraHeadInitOnChain({
		observer: getBlockfrostInstance(head.HydraRelation.network, rpcProviderApiKey),
		headId: head.headIdentifier,
		expectedVerificationKeys: [localVerificationKey, remoteVerificationKey],
		// On-chain participant tokens are minted for each node's OWN Cardano key,
		// which is decoupled from the funding hot wallet. Verify against the
		// participants' cardanoVkey, not LocalHotWallet/RemoteWallet.walletVkey.
		expectedParticipantVkeys: [head.LocalParticipant.cardanoVkey, head.RemoteParticipants[0].cardanoVkey],
		contestationPeriodSeconds: head.contestationPeriod,
	});
	if (options.persist === false) {
		return { headIdentifier: head.headIdentifier, initTxHash: verified.initTxHash };
	}
	const persisted = await prisma.hydraHead.updateMany({
		where: {
			id: head.id,
			isEnabled: true,
			headIdentifier: head.headIdentifier,
			contestationPeriod: head.contestationPeriod,
		},
		data: { initTxHash: verified.initTxHash },
	});
	if (persisted.count !== 1) throw createHttpError(409, 'Hydra head changed during on-chain verification');
	return { headIdentifier: head.headIdentifier, initTxHash: verified.initTxHash };
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

			return { heads: [serializeHydraHead(head)] };
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
		});

		return { heads: heads.map(serializeHydraHead) };
	},
});

// --- POST: create head (links pre-existing participants) ---

export const createHeadSchemaInput = z.object({
	hydraRelationId: z.string().min(1).describe('The HydraRelation this head belongs to'),
	contestationPeriod: z.coerce.number().int().min(1).default(86400).describe('Contestation period in seconds'),
	localParticipantId: z.string().min(1).describe('ID of a pre-existing HydraLocalParticipant'),
	remoteParticipantIds: z
		.array(z.string().min(1))
		.length(1)
		.describe('Exactly one pre-existing HydraRemoteParticipant for the relation counterparty'),
});

export const createHeadSchemaOutput = hydraHeadSchema;

export const createHeadPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: createHeadSchemaInput,
	output: createHeadSchemaOutput,
	handler: async ({ input }) => {
		const head = await createBoundHydraHead({
			hydraRelationId: input.hydraRelationId,
			contestationPeriod: BigInt(input.contestationPeriod),
			localParticipantId: input.localParticipantId,
			remoteParticipantId: input.remoteParticipantIds[0],
		});
		return serializeHydraHead(head);
	},
});

type VerifiedPriorHydraFanouts = {
	network: Network;
	fanoutTxHashByHeadId: ReadonlyMap<string, string>;
};

/**
 * Re-observe every completed predecessor immediately before replacement.
 * Completion disconnects its Hydra evidence sockets, so the old DB marker is
 * not enough to detect a later L1 rollback. Network I/O stays outside the
 * Serializable transaction; createBoundHydraHead then locks the relation/head
 * rows and requires this exact head/hash set before creating anything.
 */
async function verifyPriorHydraFanouts(hydraRelationId: string): Promise<VerifiedPriorHydraFanouts> {
	const relation = await prisma.hydraRelation.findUnique({
		where: { id: hydraRelationId },
		select: {
			network: true,
			LocalHotWallet: {
				select: {
					PaymentSource: {
						select: {
							network: true,
							PaymentSourceConfig: { select: { rpcProviderApiKey: true } },
						},
					},
				},
			},
			Heads: {
				where: { status: HydraHeadStatus.Final },
				select: { id: true, fanoutTxHash: true, reconciliationCompletedAt: true },
			},
		},
	});
	if (!relation) throw createHttpError(404, 'Hydra relation not found');
	if (relation.Heads.length === 0) {
		return { network: relation.network, fanoutTxHashByHeadId: new Map() };
	}
	if (relation.LocalHotWallet.PaymentSource.network !== relation.network) {
		throw createHttpError(409, 'Hydra relation and observer payment source use different networks');
	}
	const rpcProviderApiKey = relation.LocalHotWallet.PaymentSource.PaymentSourceConfig?.rpcProviderApiKey;
	if (!rpcProviderApiKey) throw createHttpError(503, 'Cannot independently re-confirm previous Hydra fanout');

	const fanoutTxHashByHeadId = new Map<string, string>();
	for (const head of relation.Heads) {
		if (
			head.reconciliationCompletedAt == null ||
			head.fanoutTxHash == null ||
			!/^[0-9a-f]{64}$/.test(head.fanoutTxHash) ||
			fanoutTxHashByHeadId.has(head.id)
		) {
			throw createHttpError(
				409,
				'Previous Hydra head fanout is not independently confirmed or its L2 state is not fully adopted',
			);
		}
		let result: Awaited<ReturnType<typeof lookupConfirmedChainTx>>;
		try {
			result = await lookupConfirmedChainTx({
				network: relation.network,
				rpcProviderApiKey,
				txHash: head.fanoutTxHash,
				requiredConfirmations: CONFIG.BLOCK_CONFIRMATIONS_THRESHOLD,
			});
		} catch {
			throw createHttpError(503, 'Cannot independently re-confirm previous Hydra fanout');
		}
		if (result === 'transient-error') {
			throw createHttpError(503, 'Cannot independently re-confirm previous Hydra fanout');
		}
		if (result !== 'confirmed-valid') {
			throw createHttpError(409, 'Previous Hydra head fanout is no longer durably confirmed on L1');
		}
		fanoutTxHashByHeadId.set(head.id, head.fanoutTxHash);
	}
	return { network: relation.network, fanoutTxHashByHeadId };
}

/**
 * Bind the singular relation participants and create the head in one guarded
 * Serializable transaction. The relation is the authorization boundary: a
 * caller cannot attach a different wallet or expand the two-party head with
 * unrelated participants. Guarded claims, the relation's partial unique index,
 * and the remote-assignment trigger make concurrent requests safe across API
 * replicas.
 */
export async function createBoundHydraHead(input: {
	hydraRelationId: string;
	contestationPeriod: bigint;
	localParticipantId: string;
	remoteParticipantId: string;
}): Promise<HydraHeadRecord> {
	const verifiedPriorFanouts = await verifyPriorHydraFanouts(input.hydraRelationId);
	try {
		return await withSerializableSlotRetry(
			() =>
				prisma.$transaction(
					async (tx) => {
						const lockedRelation = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
							SELECT "id"
							FROM "HydraRelation"
							WHERE "id" = ${input.hydraRelationId}
							FOR UPDATE
						`);
						if (lockedRelation.length !== 1) {
							throw createHttpError(404, 'Hydra relation not found');
						}
						const relation = await tx.hydraRelation.findUnique({
							where: { id: input.hydraRelationId },
							select: {
								id: true,
								network: true,
								localHotWalletId: true,
								remoteWalletId: true,
							},
						});
						if (!relation) {
							throw createHttpError(404, 'Hydra relation not found');
						}
						if (relation.network !== verifiedPriorFanouts.network) {
							throw createHttpError(409, 'Hydra relation network changed during replacement verification');
						}
						if (relation.network === Network.Mainnet && input.contestationPeriod < 43_200n) {
							throw createHttpError(400, 'Mainnet Hydra heads require a contestation period of at least 43200 seconds');
						}

						// Serialize replacement with rollback invalidation and fanout
						// adoption. Once these rows are locked, no previous Final head
						// may lose its durable proof while this replacement is created.
						await tx.$queryRaw(Prisma.sql`
							SELECT "id"
							FROM "HydraHead"
							WHERE "hydraRelationId" = ${relation.id}
							ORDER BY "id"
							FOR UPDATE
						`);
						const activeHead = await tx.hydraHead.findFirst({
							where: {
								hydraRelationId: relation.id,
								status: { not: HydraHeadStatus.Final },
							},
							select: { id: true },
						});
						if (activeHead) {
							throw createHttpError(409, 'Hydra relation already has a non-final head');
						}

						const priorFinalHeads = await tx.hydraHead.findMany({
							where: {
								hydraRelationId: relation.id,
								status: HydraHeadStatus.Final,
							},
							select: {
								id: true,
								fanoutTxHash: true,
								reconciliationCompletedAt: true,
								_count: { select: { Transactions: { where: unsettledL2TransactionWhere } } },
							},
						});
						if (
							priorFinalHeads.length !== verifiedPriorFanouts.fanoutTxHashByHeadId.size ||
							priorFinalHeads.some(
								(head) => verifiedPriorFanouts.fanoutTxHashByHeadId.get(head.id) !== head.fanoutTxHash,
							)
						) {
							throw createHttpError(409, 'Previous Hydra head fanout evidence changed during replacement verification');
						}
						const unsafePriorHead = priorFinalHeads.find(
							(head) =>
								head.fanoutTxHash == null || head.reconciliationCompletedAt == null || head._count.Transactions !== 0,
						);
						if (unsafePriorHead) {
							throw createHttpError(
								409,
								'Previous Hydra head fanout is not independently confirmed or its L2 state is not fully adopted',
							);
						}
						const priorHeadIds = priorFinalHeads.map(({ id }) => id);
						if (priorHeadIds.length > 0) {
							const [paymentHandoffs, purchaseHandoffs] = await Promise.all([
								tx.paymentRequest.count({
									where: { hydraFanoutHandoffHeadId: { in: priorHeadIds } },
								}),
								tx.purchaseRequest.count({
									where: { hydraFanoutHandoffHeadId: { in: priorHeadIds } },
								}),
							]);
							const hasUnsettledRequests = await hasUnsettledHydraRequestState(tx, priorHeadIds);
							if (paymentHandoffs !== 0 || purchaseHandoffs !== 0 || hasUnsettledRequests) {
								throw createHttpError(409, 'Previous Hydra head still has unadopted fanout handoffs');
							}
						}

						const localParticipant = await tx.hydraLocalParticipant.findUnique({
							where: { id: input.localParticipantId },
							select: {
								id: true,
								walletId: true,
								hydraHeadId: true,
								Wallet: {
									select: {
										deletedAt: true,
										PaymentSource: { select: { id: true, network: true, deletedAt: true } },
									},
								},
							},
						});
						if (!localParticipant) {
							throw createHttpError(404, `HydraLocalParticipant ${input.localParticipantId} not found`);
						}
						if (localParticipant.hydraHeadId !== null) {
							throw createHttpError(409, 'Local participant is already assigned to a head');
						}
						if (localParticipant.walletId !== relation.localHotWalletId) {
							throw createHttpError(400, 'Local participant does not belong to the Hydra relation wallet');
						}
						if (
							localParticipant.Wallet.deletedAt !== null ||
							localParticipant.Wallet.PaymentSource.deletedAt !== null
						) {
							throw createHttpError(409, 'Local participant wallet or payment source is inactive');
						}
						if (localParticipant.Wallet.PaymentSource.network !== relation.network) {
							throw createHttpError(400, 'Local participant wallet is on the wrong Cardano network');
						}

						const remoteParticipant = await tx.hydraRemoteParticipant.findUnique({
							where: { id: input.remoteParticipantId },
							select: {
								id: true,
								walletId: true,
								hydraHeadId: true,
								Wallet: {
									select: {
										PaymentSource: { select: { id: true, network: true, deletedAt: true } },
									},
								},
							},
						});
						if (!remoteParticipant) {
							throw createHttpError(404, `HydraRemoteParticipant ${input.remoteParticipantId} not found`);
						}
						if (remoteParticipant.hydraHeadId !== null) {
							throw createHttpError(409, 'Remote participant is already assigned to a head');
						}
						if (remoteParticipant.walletId !== relation.remoteWalletId) {
							throw createHttpError(400, 'Remote participant does not belong to the Hydra relation wallet');
						}
						if (remoteParticipant.Wallet.PaymentSource.deletedAt !== null) {
							throw createHttpError(409, 'Remote participant payment source is inactive');
						}
						if (remoteParticipant.Wallet.PaymentSource.network !== relation.network) {
							throw createHttpError(400, 'Remote participant wallet is on the wrong Cardano network');
						}
						if (remoteParticipant.Wallet.PaymentSource.id !== localParticipant.Wallet.PaymentSource.id) {
							throw createHttpError(400, 'Hydra relation wallets must belong to the same payment source');
						}

						const head = await tx.hydraHead.create({
							data: {
								hydraRelationId: relation.id,
								contestationPeriod: input.contestationPeriod,
							},
							select: { id: true },
						});

						const localClaim = await tx.hydraLocalParticipant.updateMany({
							where: {
								id: localParticipant.id,
								walletId: relation.localHotWalletId,
								hydraHeadId: null,
							},
							data: { hydraHeadId: head.id },
						});
						if (localClaim.count !== 1) {
							throw createHttpError(409, 'Local participant was concurrently assigned to another head');
						}

						const remoteClaim = await tx.hydraRemoteParticipant.updateMany({
							where: {
								id: remoteParticipant.id,
								walletId: relation.remoteWalletId,
								hydraHeadId: null,
							},
							data: { hydraHeadId: head.id },
						});
						if (remoteClaim.count !== 1) {
							throw createHttpError(409, 'Remote participant was concurrently assigned to another head');
						}

						return await tx.hydraHead.findUniqueOrThrow({
							where: { id: head.id },
							include: headInclude,
						});
					},
					{
						isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
						maxWait: 10_000,
						timeout: 10_000,
					},
				),
			{ label: 'hydra-head-create' },
		);
	} catch (error) {
		if (createHttpError.isHttpError(error)) {
			throw error;
		}
		if (isUniqueConstraintError(error)) {
			throw createHttpError(409, 'Hydra relation or participant was concurrently assigned to another head');
		}
		throw error;
	}
}

// --- PATCH: update isEnabled ---

export const updateHeadSchemaInput = z.object({
	id: z.string().min(1).describe('ID of the HydraHead to update'),
	isEnabled: z.boolean().describe('Whether the head should be enabled'),
});

export const updateHeadSchemaOutput = hydraHeadSchema;

export const updateHeadPatch = adminAuthenticatedEndpointFactory.build({
	method: 'patch',
	input: updateHeadSchemaInput,
	output: updateHeadSchemaOutput,
	handler: async ({ input }) => {
		return serializeHydraHead(await updateHydraHeadEnabledState(input.id, input.isEnabled));
	},
});

type VerifyHeadForEnable = (headId: string) => Promise<{ headIdentifier: string; initTxHash: string }>;

export async function updateHydraHeadEnabledState(
	id: string,
	isEnabled: boolean,
	verifyHeadForEnable: VerifyHeadForEnable = async (headId) =>
		await verifyPersistedHydraHeadOnChain(headId, { allowDisabled: true, persist: false }),
): Promise<HydraHeadRecord> {
	const existing = await prisma.hydraHead.findUnique({ where: { id } });
	if (!existing) throw createHttpError(404, 'Hydra head not found');

	const manager = getHydraConnectionManager();
	const quarantined = await prisma.hydraHead.update({
		where: { id },
		// A disabled head's prior InitTx binding is no longer an admission token.
		// Re-enable always proves the current head/participants/configuration again.
		data: { isEnabled: false, initTxHash: null },
		include: headInclude,
	});
	await manager.reconcileEnabledState(id);
	if (!isEnabled) return quarantined;

	const preInitStatuses = new Set<HydraHeadStatus>([
		HydraHeadStatus.Disconnected,
		HydraHeadStatus.Connecting,
		HydraHeadStatus.Connected,
		HydraHeadStatus.Idle,
	]);
	const requiresFreshVerification = quarantined.headIdentifier != null || !preInitStatuses.has(quarantined.status);
	let verifiedInitTxHash: string | null = null;
	if (requiresFreshVerification) {
		try {
			const verified = await verifyHeadForEnable(id);
			if (verified.headIdentifier !== quarantined.headIdentifier) {
				throw new Error('Hydra on-chain verification returned a different head identifier');
			}
			verifiedInitTxHash = verified.initTxHash;
		} catch (error) {
			if (error instanceof HydraHeadInitObservationError) {
				throw createHttpError(
					503,
					`Hydra head remains disabled until independent L1 evidence is available: ${getErrorMessage(error)}`,
				);
			}
			if (createHttpError.isHttpError(error)) throw error;
			throw createHttpError(
				502,
				`Hydra head remains disabled because independent L1 verification failed: ${getErrorMessage(error)}`,
			);
		}
	}

	const enabled = await prisma.hydraHead.updateMany({
		where: {
			id,
			isEnabled: false,
			initTxHash: null,
			updatedAt: quarantined.updatedAt,
			headIdentifier: quarantined.headIdentifier,
			contestationPeriod: quarantined.contestationPeriod,
		},
		data: { isEnabled: true, initTxHash: verifiedInitTxHash },
	});
	if (enabled.count !== 1) {
		await manager.reconcileEnabledState(id);
		throw createHttpError(409, 'Hydra head configuration or enable state changed during verification');
	}

	await manager.reconcileEnabledState(id);
	const head = await prisma.hydraHead.findUnique({ where: { id }, include: headInclude });
	if (!head) throw createHttpError(404, 'Hydra head not found');
	return head;
}

// --- POST: check node reachability/status ---

export const checkHeadNodeSchemaInput = z.object({
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

export const checkHeadNodeSchemaOutput = z.object({
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
		let nodeHttpUrl: string;
		let nodeUrl: string | undefined;
		try {
			const validationOptions = { plaintextHosts: getHydraPlaintextHosts() };
			if (input.nodeUrl) {
				const validated = validateHydraNodeUrls(input.nodeHttpUrl, input.nodeUrl, validationOptions);
				nodeHttpUrl = validated.httpUrl;
				nodeUrl = validated.wsUrl;
			} else {
				nodeHttpUrl = validateHydraHttpUrl(input.nodeHttpUrl, validationOptions);
			}
		} catch (error) {
			throw createHttpError(400, getErrorMessage(error));
		}

		const httpProbe = await probeHydraHttpNode(nodeHttpUrl, input.timeoutMs);
		const websocketProbe = nodeUrl
			? await probeHydraWebSocketNode(nodeUrl, input.timeoutMs)
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

export const headErrorSchema = z.object({
	id: z.string(),
	createdAt: z.date(),
	errorType: z.nativeEnum(HydraErrorType),
	errorMessage: z.string(),
	headStatus: z.nativeEnum(HydraHeadStatus),
	clientInput: z.string().nullable(),
	txHash: z.string().nullable(),
	errorAt: z.date(),
});

export const listHeadErrorsSchemaInput = z.object({
	headId: z.string().min(1).describe('ID of the HydraHead'),
	cursorId: z.string().optional().describe('Cursor ID for pagination'),
	limit: z.coerce.number().min(1).max(100).default(25).describe('Number of results'),
});

export const listHeadErrorsSchemaOutput = z.object({
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
		});

		return { errors };
	},
});

// --- GET: own in-head balance (local participant only) ---

export const headBalanceSchemaInput = z.object({
	headId: z.string().min(1).describe('ID of the HydraHead'),
});

export const headBalanceSchemaOutput = z.object({
	hydraHeadId: z.string(),
	address: z.string().describe('The local participant wallet address whose in-head funds are reported'),
	connected: z
		.boolean()
		.describe('True when a live head snapshot was read; false when the head has no active connection'),
	utxoCount: z.number().describe('Number of in-head UTxOs held by the local address'),
	balance: z
		.array(
			z.object({
				unit: z.string().describe('Empty string for ADA/lovelace; otherwise policyId+assetName hex'),
				quantity: z.string().describe('Aggregate quantity across the local address in-head UTxOs'),
			}),
		)
		.describe("This node's own funds currently inside the head (ADA + native tokens). Excludes the counterparty."),
});

export const getHeadBalanceGet = adminAuthenticatedEndpointFactory.build({
	method: 'get',
	input: headBalanceSchemaInput,
	output: headBalanceSchemaOutput,
	handler: async ({ input }) => {
		const balance = await getOwnInHeadBalance(input.headId);
		if (balance == null) {
			throw createHttpError(404, 'Hydra head or its local participant wallet not found');
		}
		return balance;
	},
});

// --- Lifecycle: POST init ---

export const lifecycleInput = z.object({
	headId: z.string().min(1).describe('ID of the HydraHead'),
});

export const lifecycleOutput = z.object({
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
		if (!head.isEnabled) {
			throw createHttpError(409, 'Cannot init a disabled Hydra head');
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

			// Hydra 2.3 can advance directly to Open before init() resolves. Drain
			// observed status frames and return the durable state instead of blindly
			// regressing it to Initializing.
			await cm.flushHeadStatus(head.id);
			try {
				await verifyPersistedHydraHeadOnChain(head.id);
			} catch (verificationError) {
				if (verificationError instanceof HydraHeadInitObservationError) {
					// The Init command is irreversible, while the independent index is
					// eventually consistent. Keep the authenticated node session alive and
					// quarantine L2 routing via the still-null initTxHash until a later
					// commit/lifecycle verification observes the InitTx.
					throw createHttpError(
						503,
						`Hydra head initialized, but independent L1 evidence is not available yet: ${getErrorMessage(verificationError)}`,
					);
				}
				// An initialized-but-unverified head must not remain eligible for sync or
				// lifecycle actions. Re-enabling is an explicit operator decision after
				// fixing the L1 observer or node configuration.
				await prisma.hydraHead.updateMany({ where: { id: head.id }, data: { isEnabled: false } });
				await cm.disconnect(head.id);
				throw createHttpError(
					502,
					`Hydra InitTx configuration could not be verified independently: ${getErrorMessage(verificationError)}`,
				);
			}
			const persistedHead = await prisma.hydraHead.findUnique({
				where: { id: head.id },
				select: { status: true },
			});
			if (!persistedHead) throw createHttpError(404, 'Hydra head not found');

			logger.info(`[HydraAPI] Head ${head.id} initialized`, { status: persistedHead.status });
			return { headId: head.id, status: persistedHead.status };
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

export const commitInput = z.object({
	headId: z.string().min(1).describe('ID of the HydraHead'),
});

export const commitOutput = z.object({
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
		if (!head.isEnabled) {
			throw createHttpError(409, 'Cannot commit to a disabled Hydra head');
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
		if (!head.headIdentifier) {
			throw createHttpError(409, 'Cannot commit before the Hydra head identifier has been observed');
		}

		const cm = getHydraConnectionManager();
		const hydraHead = cm.getHead(head.id);
		if (!hydraHead) {
			throw createHttpError(502, 'No active connection to Hydra head');
		}

		try {
			let verifiedHead: Awaited<ReturnType<typeof verifyPersistedHydraHeadOnChain>>;
			try {
				verifiedHead = await verifyPersistedHydraHeadOnChain(head.id);
			} catch (verificationError) {
				if (createHttpError.isHttpError(verificationError)) throw verificationError;
				throw createHttpError(
					502,
					`Refusing to sign for an unverified Hydra head: ${getErrorMessage(verificationError)}`,
				);
			}
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

			const reconcileCommit = async (): Promise<HydraCommitReconciliationResult> =>
				await reconcilePendingHydraCommit({
					id: localParticipant.id,
					hasCommitted: localParticipant.hasCommitted,
					commitTxHash: localParticipant.commitTxHash,
					commitInvalidHereafterSlot: localParticipant.commitInvalidHereafterSlot,
					network: hotWallet.PaymentSource.network,
					rpcProviderApiKey,
				});

			// A prior request may have lost the Hydra submit response or died after
			// broadcast. Never sign a replacement while that exact TTL-bearing body
			// can still land. Resolve it against trusted L1 evidence first.
			if (localParticipant.commitTxHash != null || localParticipant.commitInvalidHereafterSlot != null) {
				const reconciliation = await reconcileCommit();
				if (reconciliation === 'confirmed') {
					return {
						headId: head.id,
						committed: true,
						commitTxHash: localParticipant.commitTxHash,
					};
				}
				if (reconciliation !== 'cleared' && reconciliation !== 'none') {
					const status = reconciliation === 'transient-error' ? 503 : 409;
					throw createHttpError(
						status,
						reconciliation === 'malformed'
							? 'Pending Hydra commit evidence is incomplete; refusing an unsafe retry'
							: 'A prior Hydra commit remains pending independent L1 confirmation',
					);
				}
			}

			const { wallet, utxos, vKey, blockchainProvider } = await generateWalletExtended(
				hotWallet.PaymentSource.network,
				rpcProviderApiKey,
				hotWallet.Secret.encryptedMnemonic,
			);
			if (utxos.length === 0) {
				throw createHttpError(400, 'Local participant wallet has no L1 UTxOs available to commit');
			}

			// Datum and reference-script outputs cannot be represented faithfully by
			// the commit codec, so only plain pubkey UTxOs may be committed. Under the
			// decoupled node-key model the hydra-node funds the deposit's L1 fee,
			// collateral and change from its OWN dedicated cardano key (not this
			// participant's funding wallet), so every plain wallet UTxO can be
			// committed and no fee-fuel input needs to be reserved.
			const { commitUtxos, excludedUtxos } = selectCommitUtxos(utxos);
			if (commitUtxos.length === 0) {
				throw createHttpError(
					400,
					'Local participant wallet has no plain (datum- and reference-script-free) L1 UTxOs available to commit',
				);
			}

			logger.info(`[HydraAPI] Selected L1 UTxOs for head ${head.id} commit`, {
				commitUtxoCount: commitUtxos.length,
				excludedUtxoCount: excludedUtxos.length,
			});

			const commitDraftTx = await hydraHead.commit(commitUtxos, null, localParticipant.walletId);

			// hydra-node returns an UNSIGNED commit tx spending the wallet's L1
			// UTxOs. A missing cborHex means the node rejected the draft (returns an
			// error object, not a tx) — surface it instead of passing undefined to
			// signTx (which throws an opaque "reading 'length'" TypeError).
			if (!commitDraftTx?.cborHex) {
				throw createHttpError(502, 'Hydra node did not return a valid commit transaction draft');
			}

			// Authoritative, key-scoped wallet-input safety. A Cardano vkey witness
			// signs EVERY input under this wallet's payment key hash — not only the
			// UTxOs in the fetched snapshot — so the pure validator's snapshot check is
			// not sufficient on its own. Resolve every non-committed input the untrusted
			// draft spends against the L1 observer and refuse if any is spendable by
			// this wallet key (see assertCommitDraftInputsAreNodeFunded).
			try {
				const { inputs: draftInputs, collateral: draftCollateral } = readHydraCommitDraftInputReferences(
					commitDraftTx.cborHex,
				);
				await assertCommitDraftInputsAreNodeFunded({
					inputReferences: draftInputs,
					collateralReferences: draftCollateral,
					commitReferences: commitUtxos.map((utxo) => `${utxo.input.txHash}#${utxo.input.outputIndex}`),
					walletPaymentKeyHash: vKey,
					resolveOutput: async (inputTxHash, inputIndex) =>
						(await blockchainProvider.fetchUTxOs(inputTxHash, inputIndex)).find(
							(utxo) => utxo.input.outputIndex === inputIndex,
						)?.output ?? null,
					paymentKeyHashOf: resolvePaymentKeyHash,
				});
			} catch (inputSafetyError) {
				if (inputSafetyError instanceof HydraCommitInputSafetyError) {
					throw createHttpError(502, `Refusing unsafe Hydra commit draft: ${inputSafetyError.message}`);
				}
				throw createHttpError(
					502,
					`Refusing Hydra commit draft: could not verify funding-input ownership: ${getErrorMessage(inputSafetyError)}`,
				);
			}

			let validatedDraft: ReturnType<typeof validateHydraCommitDraft>;
			try {
				const slotConfig = resolveHydraL2EvidenceSlotConfig(convertNetwork(hotWallet.PaymentSource.network));
				if (!slotConfig) {
					throw new Error('Hydra L1 slot configuration is incomplete or invalid');
				}
				validatedDraft = validateHydraCommitDraft({
					draft: commitDraftTx,
					commitUtxos,
					walletUtxos: utxos,
					expectedHeadId: verifiedHead.headIdentifier,
					depositScriptHash: resolveHydraDepositScriptHash(),
					slotConfig,
				});
			} catch (validationError) {
				throw createHttpError(502, `Refusing unsafe Hydra commit draft: ${getErrorMessage(validationError)}`);
			}

			// Sign (partial — the draft may already carry node witnesses).
			const signedCommitTx = await wallet.signTx(commitDraftTx.cborHex, true);
			assertHydraCommitSignedBody(signedCommitTx, validatedDraft.txId);
			const commitTxHash = validatedDraft.txId;

			// Submit the signed commit tx through the hydra-node connected to the
			// head's L1. Promotion still requires independent Blockfrost evidence;
			// private devnets therefore need a separately trusted L1 observer and
			// otherwise remain fail-closed until the signed validity window expires.
			let submitResult: unknown;
			try {
				submitResult = await reserveAndSubmitHydraCommit(
					{
						participantId: localParticipant.id,
						commitTxHash,
						invalidHereafterSlot: validatedDraft.invalidHereafterSlot,
					},
					async () =>
						await hydraHead.cardanoTransaction(
							{
								type: HydraTransactionType.TxConwayEra,
								description: '',
								cborHex: signedCommitTx,
							},
							localParticipant.walletId,
						),
				);
			} catch (error) {
				if (error instanceof HydraCommitReservationConflictError) {
					throw createHttpError(409, error.message);
				}
				throw error;
			}

			// hydra-node replies `{ tag: 'TransactionSubmitted' }` on success or
			// `{ tag: 'FailedToPostTx', failureReason }` on rejection. Fail loudly so
			// the caller knows the commit never reached L1.
			const interpreted = interpretCardanoTxSubmitResult(submitResult);
			const reconciliation = await reconcilePendingHydraCommit({
				id: localParticipant.id,
				hasCommitted: false,
				commitTxHash,
				commitInvalidHereafterSlot: validatedDraft.invalidHereafterSlot,
				network: hotWallet.PaymentSource.network,
				rpcProviderApiKey,
			});
			if (reconciliation === 'confirmed') {
				await prisma.hydraHead.update({
					where: { id: head.id },
					data: { latestActivityAt: new Date() },
				});
				logger.info(`[HydraAPI] Local participant commit confirmed on L1 for head ${head.id}`, { commitTxHash });
				return {
					headId: head.id,
					committed: true,
					commitTxHash,
				};
			}
			if (reconciliation === 'cleared') {
				throw createHttpError(502, 'Hydra commit was absent after its validity deadline; retry is now safe');
			}
			if (!interpreted.ok) {
				// The node's rejection is not independent proof that the transaction was
				// never relayed. Keep the exact hash + TTL reserved for reconciliation.
				throw createHttpError(
					502,
					`Hydra node rejected the commit tx submission; L1 reconciliation remains pending: ${interpreted.reason}`,
				);
			}
			if (reconciliation === 'malformed' || reconciliation === 'none') {
				throw createHttpError(500, 'Hydra commit pending evidence could not be reconciled safely');
			}

			await prisma.hydraHead.update({
				where: { id: head.id },
				data: { latestActivityAt: new Date() },
			});
			logger.info(`[HydraAPI] Local participant commit submitted; awaiting independent L1 confirmation`, {
				headId: head.id,
				commitTxHash,
			});
			return {
				headId: head.id,
				committed: false,
				commitTxHash,
			};
		} catch (error) {
			await recordHeadError(head.id, head.status, HydraErrorType.CommandFailed, error, 'Commit');
			throw error;
		}
	},
});

// --- Lifecycle: POST close ---

export async function beginHydraHeadClose(headId: string): Promise<void> {
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
						}>
					>(Prisma.sql`
						SELECT "id", "status", "isEnabled", "isClosing", "initTxHash"
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
					if (pendingL2Transactions > 0 || activePaymentEscrows > 0 || activePurchaseEscrows > 0) {
						throw createHttpError(
							409,
							`Cannot close Hydra head with ${pendingL2Transactions} pending L2 transaction(s) and ${
								activePaymentEscrows + activePurchaseEscrows
							} active escrow output(s)`,
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

export const closeHeadPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: lifecycleInput,
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
			await beginHydraHeadClose(head.id);
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
		const response = await fetch(buildHydraHttpEndpoint(nodeHttpUrl, 'protocol-parameters'), {
			method: 'GET',
			signal: controller.signal,
			redirect: 'error',
		});
		// Reachability needs only the status line. Stop an untrusted endpoint from
		// retaining the probe with an arbitrarily large or never-ending body.
		await response.body?.cancel().catch(() => undefined);

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

async function probeHydraWebSocketNode(
	nodeUrl: string,
	timeoutMs: number,
): Promise<{ websocketReachable: boolean; status: HydraHeadStatus | null; error: string | null }> {
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
			websocket = new WebSocket(withHydraHistoryDisabled(nodeUrl), {
				// Enforce the limit in the receiver before an attacker-controlled
				// status frame is assembled in application memory.
				maxPayload: MAX_HYDRA_WS_FRAME_BYTES,
				perMessageDeflate: false,
			});
			websocket.on('open', () => {
				didOpen = true;
			});
			websocket.on('message', (data: RawData, isBinary: boolean) => {
				try {
					const parsed = parseHydraWebSocketProbeFrame(isBinary ? data : rawWebSocketProbeDataToText(data));
					const status = parseHydraStatusMessage(parsed);
					finish({ websocketReachable: true, status, error: null });
				} catch (error) {
					finish({
						websocketReachable: true,
						status: null,
						error: getErrorMessage(error),
					});
				}
			});
			websocket.on('error', () => {
				finish({
					websocketReachable: didOpen,
					status: null,
					error: 'WebSocket probe failed',
				});
			});
			websocket.on('close', () => {
				finish({
					websocketReachable: didOpen,
					status: null,
					error: didOpen ? 'WebSocket probe closed before Hydra status' : 'WebSocket probe failed to open',
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

function rawWebSocketProbeDataToText(data: RawData): string {
	if (Buffer.isBuffer(data)) return data.toString('utf8');
	if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
	return Buffer.concat(data).toString('utf8');
}
