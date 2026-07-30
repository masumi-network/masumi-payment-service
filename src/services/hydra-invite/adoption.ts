/**
 * Learning that an invite was redeemed, and turning that into a head.
 *
 * The issuing side never hears from its counterparty directly — the redemption
 * lands on its Hydra Host, and the Host has no way to reach back into a payment
 * service that may not be reachable at all. So the service asks. One watermark
 * request per Host per tick returns every redemption since the last one,
 * however many invites are outstanding.
 *
 * Latency does not matter here. Under auto-start the node is already running by
 * the time we ask; this exists so the operator can see who redeemed and shut it
 * down if it was not who they meant.
 */

import { HydraInviteRole, HydraInviteStatus } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { decrypt } from '@/utils/security/encryption';
import { fetchHostRedemptions, setHostAllowedIssuers, type HostInviteRecord } from '@/services/hydra-host/client';
import { verifyHydraRedemption } from './invite-signing';
import { createHeadFromExchange } from './orchestrator';

/**
 * How far back to re-ask when we have no watermark for a Host.
 *
 * Bounded rather than "since the beginning" so a service that has never polled
 * a Host does not adopt redemptions older than any invite it could still hold,
 * but generous enough that a restart during an exchange loses nothing.
 */
const COLD_START_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Watermark per Host, kept in memory.
 *
 * Deliberately not persisted: the cost of re-asking is one request returning
 * rows we then find already adopted, and adoption is idempotent because the
 * invite row records the head it produced. Persisting it would add a migration
 * and a failure mode — a watermark ahead of reality silently skips a redemption
 * — to save a single query after a restart.
 */
const watermarks = new Map<string, number>();

export type AdoptionOutcome = {
	polled: number;
	adopted: number;
	rejected: number;
};

/** One pass over every Host that could be holding a redemption for us. */
export async function pollHydraRedemptions(): Promise<AdoptionOutcome> {
	const hosts = await prisma.hydraHost.findMany({
		where: {
			encryptedAdminToken: { not: null },
			HydraHeadInvites: { some: { status: HydraInviteStatus.Issued, role: HydraInviteRole.Issuer } },
		},
	});

	const outcome: AdoptionOutcome = { polled: 0, adopted: 0, rejected: 0 };
	for (const host of hosts) {
		if (host.encryptedAdminToken === null) {
			continue;
		}
		const since = watermarks.get(host.id) ?? Date.now() - COLD_START_LOOKBACK_MS;
		let redemptions: { invites: HostInviteRecord[]; now: number };
		try {
			redemptions = await fetchHostRedemptions(host.baseUrl, decrypt(host.encryptedAdminToken), since);
		} catch (error) {
			// A Host that is down is not an error worth failing the tick over; the
			// watermark is untouched, so nothing is lost by trying again.
			logger.warn(`hydra: could not poll ${host.name} for redemptions: ${(error as Error).message}`);
			continue;
		}

		outcome.polled += 1;
		for (const record of redemptions.invites) {
			const result = await adoptRedemption(record);
			if (result === 'adopted') {
				outcome.adopted += 1;
			} else if (result === 'rejected') {
				outcome.rejected += 1;
			}
		}
		// Advanced only after the batch is processed, and to the Host's clock
		// rather than ours: a skewed local clock would otherwise step over
		// redemptions that arrived in the gap.
		watermarks.set(host.id, redemptions.now);
	}
	return outcome;
}

type AdoptionResult = 'adopted' | 'rejected' | 'skipped';

/**
 * Turn one Host-side redemption into a head, if it checks out.
 *
 * This is where the signature the Host could not verify is verified. The Host
 * accepted the material on the strength of a nonce alone and started the node;
 * if the signature does not hold, the head is never recorded and the operator
 * is left with a node to remove — which is the reversible half of the bargain
 * that made an unauthenticated Exchange Plane acceptable.
 */
async function adoptRedemption(record: HostInviteRecord): Promise<AdoptionResult> {
	if (record.redeemedAt === null || record.redeemer === null || record.redeemerSignature === null) {
		return 'skipped';
	}

	const invite = await prisma.hydraHeadInvite.findUnique({
		where: { nonce: record.nonce },
		include: { LocalHotWallet: true },
	});
	if (!invite || invite.role !== HydraInviteRole.Issuer) {
		return 'skipped';
	}
	if (invite.hydraHeadId !== null || invite.status === HydraInviteStatus.Completed) {
		// Already adopted. This is the normal case for a replayed watermark.
		return 'skipped';
	}

	try {
		await verifyHydraRedemption(
			{
				nonce: record.nonce,
				network: invite.network,
				redeemerWalletAddress: record.redeemer.walletAddress,
				hydraVerificationKey: record.redeemer.hydraVerificationKey,
				cardanoVerificationKey: record.redeemer.cardanoVerificationKey,
				advertise: record.redeemer.advertise,
				exchangeUrl: record.redeemer.exchangeUrl,
			},
			record.redeemerSignature,
		);
	} catch (error) {
		logger.error(
			`hydra: invite ${record.nonce} was redeemed with a signature that does not verify (${(error as Error).message}); ` +
				'the node it reserved is running and should be removed',
		);
		return 'rejected';
	}

	const participant = await prisma.hydraLocalParticipant.findFirst({
		where: { hydraHostId: invite.hydraHostId, hostNodeId: invite.hostNodeId, hydraHeadId: null },
		select: { id: true },
	});
	if (!participant) {
		logger.error(`hydra: invite ${record.nonce} has no unbound local participant to attach to a head`);
		return 'rejected';
	}

	const head = await createHeadFromExchange({
		network: invite.network,
		paymentSourceId: invite.LocalHotWallet.paymentSourceId,
		localHotWalletId: invite.localHotWalletId,
		localParticipantId: participant.id,
		counterpartyWalletAddress: record.redeemer.walletAddress,
		counterpartyExchangeUrl: record.redeemer.exchangeUrl,
		counterpartyHydraVerificationKey: record.redeemer.hydraVerificationKey,
		counterpartyCardanoVerificationKey: record.redeemer.cardanoVerificationKey,
		counterpartyAdvertise: record.redeemer.advertise,
		contestationPeriodSeconds: invite.contestationPeriodSeconds,
	});

	await prisma.hydraHeadInvite.update({
		where: { id: invite.id },
		data: {
			status: HydraInviteStatus.Completed,
			redeemedAt: new Date(record.redeemedAt),
			redeemerWalletAddress: record.redeemer.walletAddress,
			redeemerHydraVerificationKey: record.redeemer.hydraVerificationKey,
			redeemerCardanoVerificationKey: record.redeemer.cardanoVerificationKey,
			redeemerAdvertise: record.redeemer.advertise,
			redeemerExchangeUrl: record.redeemer.exchangeUrl,
			redeemerSignature: record.redeemerSignature.signature,
			redeemerSignerKey: record.redeemerSignature.key,
			HydraHead: { connect: { id: head.hydraHeadId } },
		},
	});

	logger.info(
		`hydra: invite ${record.nonce} was redeemed by ${record.redeemer.walletAddress}; head ${head.hydraHeadId} recorded`,
	);
	return 'adopted';
}

/**
 * Release invites nobody redeemed.
 *
 * An unredeemed invite holds a node, a peer port and a persistence directory,
 * and because `--peer` is startup configuration none of it can be reused for a
 * different counterparty. Sweeping is the only way it comes back.
 */
export async function reapExpiredInvites(): Promise<number> {
	const expired = await prisma.hydraHeadInvite.findMany({
		where: { status: HydraInviteStatus.Issued, expiresAt: { lt: new Date() } },
		include: { HydraHost: true },
	});

	let reaped = 0;
	for (const invite of expired) {
		try {
			if (invite.HydraHost.encryptedAdminToken !== null) {
				const adminToken = decrypt(invite.HydraHost.encryptedAdminToken);
				const { forgetHostInvite, removeHostNode } = await import('@/services/hydra-host/client');
				// The Host stops honouring the nonce before the node goes, so a
				// redemption arriving mid-sweep cannot start something we are about
				// to delete.
				await forgetHostInvite(invite.HydraHost.baseUrl, adminToken, invite.nonce);
				await removeHostNode(invite.HydraHost.baseUrl, adminToken, invite.hostNodeId, { force: false });
			}
			await prisma.hydraLocalParticipant.deleteMany({
				where: { hydraHostId: invite.hydraHostId, hostNodeId: invite.hostNodeId, hydraHeadId: null },
			});
			await prisma.hydraHeadInvite.update({
				where: { id: invite.id },
				data: { status: HydraInviteStatus.Expired },
			});
			reaped += 1;
		} catch (error) {
			// Left Issued so the next sweep retries. A node we failed to remove is
			// a wasted port, not a correctness problem.
			logger.warn(`hydra: could not reap expired invite ${invite.nonce}: ${(error as Error).message}`);
		}
	}
	return reaped;
}

/**
 * Tell each Host which wallets may POST an invite to it.
 *
 * Sent whole rather than incrementally: a Host that missed one addition would
 * silently refuse a legitimate counterparty, and a stale allow-list is invisible
 * from this side. Public material only — an address is not a secret — which is
 * what makes pushing it safe.
 */
export async function pushCounterpartyAllowlists(): Promise<number> {
	const hosts = await prisma.hydraHost.findMany({ where: { encryptedAdminToken: { not: null } } });
	if (hosts.length === 0) {
		return 0;
	}

	const relations = await prisma.hydraRelation.findMany({ include: { RemoteWallet: true } });
	const byNetwork = new Map<string, Set<string>>();
	for (const relation of relations) {
		const addresses = byNetwork.get(relation.network) ?? new Set<string>();
		addresses.add(relation.RemoteWallet.walletAddress);
		byNetwork.set(relation.network, addresses);
	}

	let pushed = 0;
	for (const host of hosts) {
		if (host.encryptedAdminToken === null) {
			continue;
		}
		const allowed = [...(byNetwork.get(host.network) ?? new Set<string>())];
		try {
			await setHostAllowedIssuers(host.baseUrl, decrypt(host.encryptedAdminToken), allowed);
			pushed += 1;
		} catch (error) {
			logger.warn(`hydra: could not push the allow-list to ${host.name}: ${(error as Error).message}`);
		}
	}
	return pushed;
}
