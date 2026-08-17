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
import { fetchHostRedemptions, forgetHostInvite, type HostInviteRecord } from '@/services/hydra-host/client';
import { verifyHydraRedemption } from './invite-signing';
import { createHeadFromExchange } from './orchestrator';
import { releaseReservedParticipants } from './release-reservation';
import { fundHydraNodeNow } from '@/services/hydra-node-funding/service';

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
			redemptions = await fetchHostRedemptions(host.baseUrl, decrypt(host.encryptedAdminToken), since, {
				allowInsecureHttp: host.allowInsecureHttp,
			});
		} catch (error) {
			// A Host that is down is not an error worth failing the tick over; the
			// watermark is untouched, so nothing is lost by trying again.
			logger.warn(`hydra: could not poll ${host.name} for redemptions: ${(error as Error).message}`);
			continue;
		}

		outcome.polled += 1;
		// The oldest redemption this batch could not adopt, so the next pass can
		// see it again. The Host filters strictly on `redeemedAt > since`, so a
		// watermark moved past a failure hides that redemption for the life of the
		// process — and the ordinary failure here is temporary: the relation still
		// holds a head that has not reached Final, which the operator finalises
		// minutes later. Nothing retried it, the invite stayed Issued with no
		// head, and only a restart (which falls back to the cold-start lookback)
		// ever picked it up again.
		let retryFromMs: number | null = null;
		for (const record of redemptions.invites) {
			let result: AdoptionResult;
			try {
				result = await adoptRedemption(record);
			} catch (error) {
				if (record.redeemedAt !== null) {
					retryFromMs = retryFromMs === null ? record.redeemedAt : Math.min(retryFromMs, record.redeemedAt);
				}
				// One redemption that cannot be adopted must not stop the others, and
				// must not stop the pass. It used to: the throw escaped this loop and
				// the Host loop, the watermark was never advanced, and every later
				// Host went unpolled — so a single counterparty whose relation still
				// held a live head silently froze invite adoption for everybody, and
				// re-ran the same failure on every tick.
				logger.warn(`hydra: could not adopt redemption ${record.nonce}: ${(error as Error).message}`);
				outcome.rejected += 1;
				continue;
			}
			if (result === 'adopted') {
				outcome.adopted += 1;
				// The database nonce remains the permanent replay guard. Once the
				// signed redemption is adopted, the Host no longer needs to retain
				// its public-plane copy or its larger key/signature payload.
				await forgetHostInvite(host.baseUrl, decrypt(host.encryptedAdminToken), record.nonce, {
					allowInsecureHttp: host.allowInsecureHttp,
				}).catch((error: unknown) =>
					logger.warn(`hydra: could not prune adopted invite ${record.nonce}: ${(error as Error).message}`),
				);
			} else if (result === 'rejected') {
				outcome.rejected += 1;
			}
		}
		// Advanced only after the batch is processed, and to the Host's clock
		// rather than ours: a skewed local clock would otherwise step over
		// redemptions that arrived in the gap. Held back to just before the oldest
		// failure when there was one, so the next pass is offered it again.
		// A redemption that was *rejected* rather than failed is not retried: its
		// signature did not hold, and asking again cannot change that.
		watermarks.set(host.id, retryFromMs !== null ? retryFromMs - 1 : redemptions.now);
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

	// Fund now rather than on the next cycle. This is the issuing side, which
	// was deliberately left unfunded while the invite sat unredeemed — a head
	// exists as of this moment, so its node is about to owe a commit.
	void fundHydraNodeNow(participant.id).catch((error: unknown) => {
		logger.warn(`hydra: could not fund the node for head ${head.hydraHeadId}: ${(error as Error).message}`);
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
				const { removeHostNode } = await import('@/services/hydra-host/client');
				const transport = { allowInsecureHttp: invite.HydraHost.allowInsecureHttp };

				// An invite is expired here but may have been redeemed a moment before
				// it expired — the Host accepts a redemption right up to the deadline,
				// and the poll that adopts it runs on its own schedule and skips a
				// Host it could not reach. Forgetting it destroys the only copy of the
				// counterparty's signed redemption there is, leaving them with a live
				// head whose peer will never join and us with nothing to reconstruct
				// it from. Adoption gets the next tick instead; the sweep gets it
				// afterwards, when the invite is Completed or still unredeemed.
				const held = await fetchHostRedemptions(invite.HydraHost.baseUrl, adminToken, 0, transport);
				if (held.invites.some((record) => record.nonce === invite.nonce && record.redeemedAt !== null)) {
					logger.info(`hydra: not reaping expired invite ${invite.nonce}; the Host is holding its redemption`);
					continue;
				}

				// The Host stops honouring the nonce before the node goes, so a
				// redemption arriving mid-sweep cannot start something we are about
				// to delete.
				await forgetHostInvite(invite.HydraHost.baseUrl, adminToken, invite.nonce, transport);
				await removeHostNode(invite.HydraHost.baseUrl, adminToken, invite.hostNodeId, {
					force: false,
					...transport,
				});
			}
			await releaseReservedParticipants({ hydraHostId: invite.hydraHostId, hostNodeId: invite.hostNodeId });
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
