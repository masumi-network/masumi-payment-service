/**
 * Verify staged redemptions before the Host spends the nonce.
 *
 * The Exchange Plane cannot check a signature, so it only stages what a
 * counterparty posts. This is where the signature is checked. A candidate that
 * does not verify is rejected and dropped, and the invite stays open, so a
 * forged POST cannot lock out the intended redeemer or strand the node and its
 * fuel. The first candidate that verifies is confirmed, which spends the nonce
 * and configures the reserved node in one Host call.
 */

import { HydraInviteRole, HydraInviteStatus } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import {
	confirmHostRedemption,
	rejectHostRedemption,
	type HostInviteRecord,
	type HostTransportOptions,
} from '@/services/hydra-host/client';
import { verifyHydraRedemption } from './invite-signing';

export type StagedRedemptionOutcome = {
	/** The Host's record after confirmation, or null when nothing was confirmed. */
	confirmed: HostInviteRecord | null;
	rejected: number;
};

export async function settleStagedRedemptions(
	host: { baseUrl: string; adminToken: string; transport: HostTransportOptions },
	record: HostInviteRecord,
): Promise<StagedRedemptionOutcome> {
	const outcome: StagedRedemptionOutcome = { confirmed: null, rejected: 0 };
	const staged = [...(record.staged ?? [])].sort((left, right) => left.stagedAt - right.stagedAt);
	if (record.redeemedAt !== null || staged.length === 0) return outcome;

	const invite = await prisma.hydraHeadInvite.findUnique({
		where: { nonce: record.nonce },
		select: { role: true, status: true, hydraHeadId: true, network: true },
	});
	// Only an open invite we issued. Anything else is not ours to settle, and a
	// finished invite must not have its nonce spent now.
	if (
		!invite ||
		invite.role !== HydraInviteRole.Issuer ||
		invite.status !== HydraInviteStatus.Issued ||
		invite.hydraHeadId !== null
	) {
		return outcome;
	}

	for (const candidate of staged) {
		try {
			await verifyHydraRedemption(
				{
					nonce: record.nonce,
					network: invite.network,
					redeemerWalletAddress: candidate.redeemer.walletAddress,
					hydraVerificationKey: candidate.redeemer.hydraVerificationKey,
					cardanoVerificationKey: candidate.redeemer.cardanoVerificationKey,
					advertise: candidate.redeemer.advertise,
					exchangeUrl: candidate.redeemer.exchangeUrl,
				},
				candidate.signature,
			);
		} catch (error) {
			logger.warn(
				`hydra: dropping a staged redemption of invite ${record.nonce} from ${candidate.redeemer.walletAddress}: ` +
					`its signature does not verify (${(error as Error).message}); the invite stays open`,
			);
			await rejectHostRedemption(host.baseUrl, host.adminToken, record.nonce, candidate.id, host.transport);
			outcome.rejected += 1;
			continue;
		}
		outcome.confirmed = await confirmHostRedemption(
			host.baseUrl,
			host.adminToken,
			record.nonce,
			candidate.id,
			host.transport,
		);
		return outcome;
	}
	return outcome;
}
