/**
 * Loading and validating one head's configured identity before any transport
 * is started: the durable row, its participants and their relation binding,
 * network agreement, transport URLs, and the participant verification keys.
 *
 * Everything here fails closed with a thrown error — a head whose
 * configuration cannot be proven consistent never gets a socket.
 */

import { prisma } from '@masumi/payment-core/db';
import { validateHydraNodeUrls } from '@/lib/hydra';
import {
	deriveHydraVerificationKeyCborHex,
	normalizeHydraVerificationKeyCborHex,
} from '@/lib/hydra/hydra/snapshot-verification';
import { HydraHeadStatus, Prisma } from '@/generated/prisma/client';
import { decrypt } from '@/utils/security/encryption';

export const HYDRA_PRE_INIT_STATUSES = new Set<HydraHeadStatus>([
	HydraHeadStatus.Disconnected,
	HydraHeadStatus.Connecting,
	HydraHeadStatus.Connected,
	HydraHeadStatus.Idle,
]);

export const hydraRelationSecuritySelect = {
	network: true,
	localHotWalletId: true,
	remoteWalletId: true,
	LocalHotWallet: {
		select: {
			deletedAt: true,
			PaymentSource: { select: { network: true, deletedAt: true, disableSyncAt: true } },
		},
	},
	RemoteWallet: {
		select: {
			PaymentSource: { select: { network: true, deletedAt: true, disableSyncAt: true } },
		},
	},
} as const;

export const headConfigurationInclude = {
	LocalParticipant: { include: { HydraSecretKey: true, HydraHost: true } },
	RemoteParticipants: { include: { HydraVerificationKey: true } },
	HydraRelation: { select: hydraRelationSecuritySelect },
} as const;

export type ConfiguredHead = Prisma.HydraHeadGetPayload<{ include: typeof headConfigurationInclude }> & {
	LocalParticipant: NonNullable<
		Prisma.HydraHeadGetPayload<{ include: typeof headConfigurationInclude }>['LocalParticipant']
	>;
};

export interface LoadedHeadConfiguration {
	configuredHead: ConfiguredHead;
	nodeUrls: { httpUrl: string; wsUrl: string };
	nodeAuthToken: string | undefined;
	localVerificationKey: string;
	remoteVerificationKeys: string[];
	reconciledHistoryCursor: { snapshotSequence: number; snapshotTransactionIndex: number } | undefined;
}

export function resolvePersistedHistoryCursor(head: {
	id: string;
	lastReconciledSnapshotSequence?: bigint | null;
	lastReconciledSnapshotTransactionIndex?: number | null;
}): { snapshotSequence: number; snapshotTransactionIndex: number } | undefined {
	const sequence = head.lastReconciledSnapshotSequence;
	const index = head.lastReconciledSnapshotTransactionIndex;
	if (sequence == null && index == null) return undefined;
	if (sequence == null || index == null || sequence < 0n || !Number.isSafeInteger(index) || index < 0) {
		throw new Error(`Hydra head ${head.id} has an invalid persisted reconciliation cursor`);
	}
	const sequenceNumber = Number(sequence);
	if (!Number.isSafeInteger(sequenceNumber)) {
		throw new Error(`Hydra head ${head.id} reconciliation cursor exceeds the supported sequence range`);
	}
	return { snapshotSequence: sequenceNumber, snapshotTransactionIndex: index };
}

/**
 * The bearer token for reaching this head's node.
 *
 * A node configured by hand on loopback has nothing in front of it, so there
 * is nothing to authenticate to and this is undefined. A node placed on a
 * Hydra Host is reachable only through that Host's proxy, so its user token
 * is decrypted here — the single seam every caller reads, so the credential
 * cannot be threaded correctly in one place and forgotten in another.
 */
export function resolveNodeAuthToken(host: { encryptedUserToken: string } | null | undefined): string | undefined {
	if (host == null) {
		return undefined;
	}
	return decrypt(host.encryptedUserToken);
}

export async function loadValidatedHeadConfiguration(hydraHeadId: string): Promise<LoadedHeadConfiguration> {
	const configuredHead = await prisma.hydraHead.findUnique({
		where: { id: hydraHeadId },
		include: headConfigurationInclude,
	});
	if (!configuredHead) {
		throw new Error(`Hydra head ${hydraHeadId} not found`);
	}
	if (configuredHead.isEnabled !== true) {
		throw new Error(`Hydra head ${hydraHeadId} is disabled`);
	}
	if (configuredHead.initTxHash == null && !HYDRA_PRE_INIT_STATUSES.has(configuredHead.status)) {
		throw new Error(`Hydra head ${hydraHeadId} has not passed independent InitTx verification`);
	}
	if (!configuredHead.LocalParticipant) {
		throw new Error('No local participant provided');
	}
	if (configuredHead.RemoteParticipants.length !== 1) {
		throw new Error('Hydra two-party heads require exactly one configured remote participant verification key');
	}
	if (
		configuredHead.LocalParticipant.walletId !== configuredHead.HydraRelation.localHotWalletId ||
		configuredHead.RemoteParticipants[0].walletId !== configuredHead.HydraRelation.remoteWalletId
	) {
		throw new Error('Hydra participants did not match the wallets bound by their Hydra relation');
	}
	const relation = configuredHead.HydraRelation;
	const localPaymentSource = relation.LocalHotWallet.PaymentSource;
	const remotePaymentSource = relation.RemoteWallet.PaymentSource;
	if (relation.network !== localPaymentSource.network || relation.network !== remotePaymentSource.network) {
		throw new Error('Hydra relation and participant payment sources must use the same network');
	}
	if (
		relation.LocalHotWallet.deletedAt !== null ||
		localPaymentSource.deletedAt !== null ||
		remotePaymentSource.deletedAt !== null ||
		localPaymentSource.disableSyncAt !== null ||
		remotePaymentSource.disableSyncAt !== null
	) {
		throw new Error('Hydra relation participants must belong to active, sync-enabled payment sources');
	}
	const decryptedSigningKey = decrypt(configuredHead.LocalParticipant.HydraSecretKey.hydraSK);
	const localVerificationKey = deriveHydraVerificationKeyCborHex(decryptedSigningKey);
	const remoteVerificationKeys = configuredHead.RemoteParticipants.map(({ HydraVerificationKey }) => {
		try {
			return normalizeHydraVerificationKeyCborHex(HydraVerificationKey.hydraVK);
		} catch (plaintextError) {
			// Compatibility for rows created by the legacy seed/reconciliation
			// scripts, which encrypted this public key by mistake.
			try {
				return normalizeHydraVerificationKeyCborHex(decrypt(HydraVerificationKey.hydraVK));
			} catch {
				throw plaintextError;
			}
		}
	});

	const hostTransport = configuredHead.LocalParticipant.HydraHost;
	const persistedNodeHttpUrl = new URL(configuredHead.LocalParticipant.nodeHttpUrl);
	if (persistedNodeHttpUrl.protocol === 'http:' && !hostTransport.allowInsecureHttp) {
		throw new Error(`Hydra head ${hydraHeadId} uses HTTP without the Host's explicit allowInsecureHttp opt-in`);
	}
	const nodeUrls = validateHydraNodeUrls(
		configuredHead.LocalParticipant.nodeHttpUrl,
		configuredHead.LocalParticipant.nodeUrl,
		{
			plaintextHosts: hostTransport.allowInsecureHttp ? [persistedNodeHttpUrl.hostname] : [],
		},
	);
	const nodeAuthToken = resolveNodeAuthToken(hostTransport);
	return {
		configuredHead: configuredHead as ConfiguredHead,
		nodeUrls,
		nodeAuthToken,
		localVerificationKey,
		remoteVerificationKeys,
		reconciledHistoryCursor: resolvePersistedHistoryCursor(configuredHead),
	};
}
