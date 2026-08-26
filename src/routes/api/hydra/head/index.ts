import { adminAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { CONFIG } from '@masumi/payment-core/config';
import { z } from '@masumi/payment-core/zod';
import { prisma } from '@masumi/payment-core/db';
import createHttpError from 'http-errors';
import { HydraHeadStatus, HydraInviteRole, HotWalletType, Network, Prisma } from '@/generated/prisma/client';
import { getHydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';
// Re-exported so callers that reach for it here keep working; it lives apart to
// stay reachable from the connection manager without a cycle.
export { recordHeadError } from '@/services/hydra-head-error/record';
// Re-exported in full so the split is invisible to the api barrel, to the
// OpenAPI docs module, and to any other caller that reaches for these here.
export {
	clearHeadErrorsDelete,
	clearHeadErrorsSchemaInput,
	clearHeadErrorsSchemaOutput,
	getHeadBalanceGet,
	getHeadConnectionGet,
	headBalanceSchemaInput,
	headBalanceSchemaOutput,
	headConnectionSchemaInput,
	headConnectionSchemaOutput,
	headErrorSchema,
	listHeadErrorsGet,
	listHeadErrorsSchemaInput,
	listHeadErrorsSchemaOutput,
} from './observability';
import { readParticipantNodeState } from '@/services/hydra-host/node-state';
import {
	deriveHydraVerificationKeyCborHex,
	HydraHeadInitObservationError,
	normalizeHydraVerificationKeyCborHex,
	resolveHydraInitChainAnchor,
	verifyHydraHeadInitOnChain,
} from '@/lib/hydra';
import { toPrismaJsonValue } from '@/utils/json-value';
import { getBlockfrostInstance } from '@/utils/blockfrost';
import { decrypt } from '@/utils/security/encryption';
import { lookupConfirmedChainTx } from '@/services/shared/chain-tx-lookup';

// --- Shared schemas ---

export const localParticipantSchema = z.object({
	id: z.string(),
	createdAt: z.string(),
	walletId: z.string(),
	Wallet: z.object({
		walletVkey: z.string(),
		walletAddress: z.string(),
		collectionAddress: z.string().nullable(),
		note: z.string().nullable(),
		type: z.nativeEnum(HotWalletType),
	}),
	nodeUrl: z.string(),
	nodeHttpUrl: z.string(),
	hasCommitted: z.boolean(),
	commitTxHash: z.string().nullable(),
	/**
	 * Which connected node runs this head's process.
	 *
	 * A head is pinned to one node for its whole life and cannot be moved, so
	 * this is a property of the head rather than a lookup — and the admin lists
	 * heads under their node, which it could not do without it.
	 */
	hydraHostId: z.string(),
	hostNodeId: z.string(),
	/**
	 * The node's own Cardano key hash — the head's on-chain participant identity,
	 * deliberately separate from the settling wallet (ADR 0015 §3). Public
	 * material: it is what the InitTx mints a participant token for.
	 */
	cardanoVkey: z.string(),

	/** Null until an operator has taken the one-time backup of this node's keys. */
	keysDisclosedAt: z.string().nullable(),
});

export const remoteParticipantSchema = z.object({
	id: z.string(),
	createdAt: z.string(),
	walletId: z.string(),
	Wallet: z.object({
		walletVkey: z.string(),
		walletAddress: z.string(),
	}),
	/** Peer-plane `host:port`, as the counterparty advertised it. Not an API URL. */
	advertise: z.string(),
	hasCommitted: z.boolean(),
	commitTxHash: z.string().nullable(),
	/** The counterparty node's Hydra verification key (cborHex), not its row id. */
	HydraVerificationKey: z.object({ hydraVK: z.string() }),
	/**
	 * The node's own Cardano key hash — the head's on-chain participant identity,
	 * deliberately separate from the settling wallet (ADR 0015 §3). Public
	 * material: it is what the InitTx mints a participant token for.
	 */
	cardanoVkey: z.string(),
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
		Invite: z
			.object({
				role: z.nativeEnum(HydraInviteRole),
				/** The head's agreed parameters, fixed when the invite was issued. */
				contestationPeriodSeconds: z.number(),
				depositPeriodSeconds: z.number(),
				unsyncedPeriodSeconds: z.number(),
			})
			.nullable()
			.optional()
			.describe('Which side of the invite exchange this head came from; absent for heads not created from one'),
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
	/**
	 * A head belongs to exactly one network for its whole life, through its
	 * relation. Filterable because the callers that show heads are themselves
	 * scoped to one — an unscoped list mixes chains, and every hash in it then
	 * links to whichever explorer the caller assumed.
	 */
	network: z.nativeEnum(Network).optional().describe('Filter by Cardano network'),
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

export const headInclude = {
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
			Wallet: {
				select: {
					walletVkey: true,
					walletAddress: true,
					collectionAddress: true,
					note: true,
					type: true,
				},
			},
			nodeUrl: true,
			nodeHttpUrl: true,
			hasCommitted: true,
			commitTxHash: true,
			// A head is pinned to one node for life, so the admin lists heads
			// under theirs; without these it cannot tell which.
			hydraHostId: true,
			hostNodeId: true,
			cardanoVkey: true,
			// So the UI can offer the one-time key backup, and stop offering it.
			keysDisclosedAt: true,
		},
	},
	RemoteParticipants: {
		select: {
			id: true,
			createdAt: true,
			walletId: true,
			Wallet: { select: { walletVkey: true, walletAddress: true } },
			advertise: true,
			hasCommitted: true,
			commitTxHash: true,
			// The key itself, not the row that holds it. The id is meaningless to
			// an operator, and this is the value they compare against what the
			// counterparty says their node runs. Public material either way: it is
			// exchanged in the handshake and lives in the head's on-chain identity.
			HydraVerificationKey: { select: { hydraVK: true } },
			cardanoVkey: true,
		},
	},
	// The role decides which side may post the Init. The three durations come
	// with it because they are the head's agreed parameters — fixed at issue,
	// covered by the issuer signature, unchangeable afterwards — and an operator
	// reading a stuck deposit or a long close has no other place to find them.
	// The rest of the invite is exchange bookkeeping the head view has no use for.
	Invite: {
		select: {
			role: true,
			contestationPeriodSeconds: true,
			depositPeriodSeconds: true,
			unsyncedPeriodSeconds: true,
		},
	},
	_count: { select: { Errors: true, Transactions: true } },
} as const;

export type HydraHeadRecord = Prisma.HydraHeadGetPayload<{ include: typeof headInclude }>;

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
export async function verifyPersistedHydraHeadOnChain(
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

	const observer = getBlockfrostInstance(head.HydraRelation.network, rpcProviderApiKey);
	const verified = await verifyHydraHeadInitOnChain({
		observer,
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
	// The anchor rides the same L1 evidence pass as initTxHash: a failure here
	// throws like any other observation error and the caller (backfill,
	// lifecycle) retries the whole verification on its next cycle.
	const anchor = await resolveHydraInitChainAnchor(observer, verified.initTxHash);
	const persisted = await prisma.hydraHead.updateMany({
		where: {
			id: head.id,
			isEnabled: true,
			headIdentifier: head.headIdentifier,
			contestationPeriod: head.contestationPeriod,
		},
		data: {
			initTxHash: verified.initTxHash,
			...(anchor ? { initChainSlot: anchor.slot, initChainHash: anchor.hash } : {}),
		},
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
				...(input.network ? { HydraRelation: { network: input.network } } : {}),
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
export async function verifyPriorHydraFanouts(hydraRelationId: string): Promise<VerifiedPriorHydraFanouts> {
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
// --- PATCH: update isEnabled ---

/**
 * Refuse a deposit while the node cannot absorb it.
 *
 * A deposit is only takeable between one deposit period and three, measured in
 * the node's own chain time. A node still catching up is not going to fold one
 * in, and the deposit is on chain the moment it is submitted — so accepting the
 * request puts the operator's funds behind a deadline that passes while nothing
 * is watching. The admin UI already said "still catching up"; the API took the
 * funds anyway.
 *
 * Applies to the initial commit and to every later top-up: they are the same
 * on-chain object with the same deadline.
 */
export async function assertNodeReadyForDeposit(localParticipantId: string): Promise<void> {
	const node = await readParticipantNodeState(localParticipantId);
	if (!node.isReady) {
		throw createHttpError(
			409,
			node.reason ??
				`The Hydra node is not ready to take a deposit (state ${node.state}). It is still catching up on chain, and funds sent now would expire before the head could absorb them.`,
		);
	}
}

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

// --- Helpers ---

export function getErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}
