/**
 * Keeping every hydra-node's Cardano key funded.
 *
 * A node cannot open a head from an empty address. The InitTx consumes a seed
 * UTxO to derive the head's identifier and pays its fee from the same key, so a
 * freshly provisioned node — which is every node, since the Host generates the
 * key — fails with `postTxError: NoSeedInput` until someone sends it ADA. The
 * same key later pays for Close and Fanout, so it has to stay funded for the
 * head's whole life, not just its opening.
 *
 * This is a *transfer*, not a shared key. ADR 0010 §3 keeps the node's
 * infrastructure key separate from the custodial funding wallet so that a
 * compromised host cannot reach escrowed funds; funding it by moving a small,
 * bounded amount preserves that.
 *
 * Distinct from the Hydra top-up in `hydra-low-balance/auto-topup`, which
 * commits funds *into an already-open head* on L2. This runs before that is
 * possible, on L1, and against a different address.
 */

import { HydraInviteStatus, TransactionStatus } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { getBlockfrostInstance } from '@/utils/blockfrost';
import { nodeCardanoAddress } from './node-address';

/**
 * Below this, a node is topped up.
 *
 * Chosen to cover what a head actually costs its node key over a full
 * lifecycle: a seed UTxO plus fees for Init, Close and Fanout, with room for
 * one contested close. Well under what an operator would notice, and the point
 * is availability rather than thrift — a node that cannot pay a Fanout fee
 * strands funds behind a contestation deadline.
 */
export const NODE_MINIMUM_LOVELACE = 5_000_000n;

/** Topped up to this, so a node is not refunded every cycle for a few lovelace. */
export const NODE_TARGET_LOVELACE = 10_000_000n;

/** Bounded so one bad cycle cannot drain a funding wallet. */
const MAX_TOPUPS_PER_CYCLE = 5;

export type NodeFundingOutcome = {
	checked: number;
	funded: number;
	skipped: number;
};

/** Blockfrost signals an unused address with a 404 on the error object itself. */
export function isNotFound(error: unknown): boolean {
	if (typeof error === 'object' && error !== null) {
		const status = (error as { status_code?: unknown }).status_code;
		if (status === 404) {
			return true;
		}
	}
	return /\b404\b/.test((error as Error)?.message ?? '');
}

async function readLovelaceAt(address: string, network: 'Preprod' | 'Mainnet', apiKey: string): Promise<bigint | null> {
	try {
		const blockfrost = getBlockfrostInstance(network, apiKey);
		const details = await blockfrost.addressesExtended(address);
		const lovelace = details.amount.find((entry) => entry.unit === 'lovelace');
		return BigInt(lovelace?.quantity ?? '0');
	} catch (error) {
		// A never-used address has no record at all. That is zero, not a failure —
		// and it is the state every newly provisioned node starts in, so reading it
		// as "unknown" means never funding the nodes that most need it.
		//
		// Detected on the status code, not the message. Blockfrost words this as
		// "The requested component has not been found", which does not contain the
		// substring "not found" — so matching on prose silently inverted this for
		// exactly the addresses it was written to cover.
		if (isNotFound(error)) {
			return 0n;
		}
		logger.warn(`hydra: could not read the balance of node address ${address}: ${(error as Error).message}`);
		return null;
	}
}

/**
 * One pass over the nodes that could need funding.
 *
 * Covers a node from the moment it is reserved, not from the moment a head
 * exists. Funding only head-bound participants avoided tying up ADA in an
 * invite that might be revoked, but it meant the operator who finally pressed
 * Init met a funding delay at the worst possible moment — and an invite is
 * revocable, which returns the money anyway.
 */
export async function runHydraNodeFundingCycle(): Promise<NodeFundingOutcome> {
	// An invite names its reservation by (host, node), which is the same pair a
	// participant carries — so the live invites are resolved first and matched
	// exactly, rather than by asking whether the *Host* has any live invite,
	// which would sweep in every other node on that Host.
	const liveInvites = await prisma.hydraHeadInvite.findMany({
		where: { status: { in: [HydraInviteStatus.Issued, HydraInviteStatus.Redeemed, HydraInviteStatus.Started] } },
		select: { hydraHostId: true, hostNodeId: true },
	});

	const participants = await prisma.hydraLocalParticipant.findMany({
		where: {
			OR: [
				{ hydraHeadId: { not: null } },
				// Reserved by an invite that is still alive. A revoked or expired
				// one is reaped, and its node goes with it.
				...liveInvites.map((invite) => ({
					hydraHostId: invite.hydraHostId,
					hostNodeId: invite.hostNodeId,
				})),
			],
		},
		include: {
			Wallet: { include: { PaymentSource: { include: { PaymentSourceConfig: true } } } },
			HydraHead: { select: { id: true, status: true } },
		},
	});

	const outcome: NodeFundingOutcome = { checked: 0, funded: 0, skipped: 0 };

	for (const participant of participants) {
		if (outcome.funded >= MAX_TOPUPS_PER_CYCLE) {
			outcome.skipped += 1;
			continue;
		}

		const network = participant.Wallet.PaymentSource.network;
		let address: string;
		try {
			address = nodeCardanoAddress(participant.cardanoVkey, network);
		} catch (error) {
			logger.error(`hydra: node ${participant.hostNodeId} has an unusable key hash: ${(error as Error).message}`);
			outcome.skipped += 1;
			continue;
		}

		// One in-flight transfer per node. A transfer takes a while to confirm and
		// the balance does not move until it does, so every cycle inside that
		// window would otherwise queue another and fund the node several times
		// over from the operator's wallet.
		//
		// Deliberately not restricted to transfers without a txHash: the window
		// that matters is precisely the one *after* submission, where the hash
		// exists and the chain has yet to catch up. Requiring a null hash here
		// left that window unguarded, which is how a second transfer was queued
		// for a node that had already been paid.
		const inFlight = await prisma.walletFundTransfer.findFirst({
			where: { toAddress: address, status: TransactionStatus.Pending },
		});
		if (inFlight !== null) {
			outcome.skipped += 1;
			continue;
		}

		outcome.checked += 1;
		const balance = await readLovelaceAt(
			address,
			network,
			participant.Wallet.PaymentSource.PaymentSourceConfig.rpcProviderApiKey,
		);
		if (balance === null || balance >= NODE_MINIMUM_LOVELACE) {
			continue;
		}

		const amount = NODE_TARGET_LOVELACE - balance;
		await prisma.walletFundTransfer.create({
			data: {
				hotWalletId: participant.walletId,
				toAddress: address,
				lovelaceAmount: amount,
			},
		});
		outcome.funded += 1;
		logger.info(
			`hydra: funding node ${participant.hostNodeId} with ${amount} lovelace ` +
				`(head ${participant.hydraHeadId ?? 'none'}, balance was ${balance})`,
		);
	}

	return outcome;
}

export type NodeFundingState = {
	address: string;
	balanceLovelace: bigint;
	/** True when the node cannot pay for an L1 action, so Init would fail. */
	isUnderfunded: boolean;
	/** What a top-up would send, so a caller can offer it rather than describe it. */
	shortfallLovelace: bigint;
	/** Null when the chain could not be consulted — unknown, not zero. */
	checked: boolean;
};

/**
 * What a node's key currently holds, and whether that is enough.
 *
 * Read before an L1 action rather than after it fails. Init that fails for want
 * of funds does so slowly and opaquely: the node posts nothing, the service
 * waits out its timeout, and the operator sees a gateway timeout with no
 * mention of money.
 */
export async function readNodeFundingState(localParticipantId: string): Promise<NodeFundingState> {
	const participant = await prisma.hydraLocalParticipant.findUniqueOrThrow({
		where: { id: localParticipantId },
		include: { Wallet: { include: { PaymentSource: { include: { PaymentSourceConfig: true } } } } },
	});
	const network = participant.Wallet.PaymentSource.network;
	const address = nodeCardanoAddress(participant.cardanoVkey, network);
	const balance = await readLovelaceAt(
		address,
		network,
		participant.Wallet.PaymentSource.PaymentSourceConfig.rpcProviderApiKey,
	);

	if (balance === null) {
		// Unknown is not underfunded: refusing an action because a chain lookup
		// failed would turn a Blockfrost hiccup into an outage.
		return { address, balanceLovelace: 0n, isUnderfunded: false, shortfallLovelace: 0n, checked: false };
	}
	return {
		address,
		balanceLovelace: balance,
		isUnderfunded: balance < NODE_MINIMUM_LOVELACE,
		shortfallLovelace: balance < NODE_MINIMUM_LOVELACE ? NODE_TARGET_LOVELACE - balance : 0n,
		checked: true,
	};
}

/**
 * Fund one node now, rather than waiting for the cycle.
 *
 * Exists because the wait is the worst part of the first head an operator
 * opens: Init fails with a message about a seed input, and the fix is invisible
 * and minutes away. Returns what it did so the caller can say so.
 */
export async function fundHydraNodeNow(localParticipantId: string): Promise<{
	address: string;
	balanceLovelace: string;
	transferredLovelace: string | null;
}> {
	const participant = await prisma.hydraLocalParticipant.findUniqueOrThrow({
		where: { id: localParticipantId },
		include: { Wallet: { include: { PaymentSource: { include: { PaymentSourceConfig: true } } } } },
	});

	const network = participant.Wallet.PaymentSource.network;
	const address = nodeCardanoAddress(participant.cardanoVkey, network);
	const balance =
		(await readLovelaceAt(address, network, participant.Wallet.PaymentSource.PaymentSourceConfig.rpcProviderApiKey)) ??
		0n;

	if (balance >= NODE_MINIMUM_LOVELACE) {
		return { address, balanceLovelace: balance.toString(), transferredLovelace: null };
	}

	// The same one-in-flight rule the cycle applies, for the same reason: the
	// balance does not move until a transfer confirms, so anything asking again
	// inside that window sees zero and pays again. Redeeming an invite funds the
	// node immediately and the cycle funds it too, which is exactly this window —
	// it sent 10 ADA twice to every node opened so far.
	const inFlight = await prisma.walletFundTransfer.findFirst({
		where: { toAddress: address, status: TransactionStatus.Pending },
	});
	if (inFlight !== null) {
		return { address, balanceLovelace: balance.toString(), transferredLovelace: null };
	}

	const amount = NODE_TARGET_LOVELACE - balance;
	await prisma.walletFundTransfer.create({
		data: { hotWalletId: participant.walletId, toAddress: address, lovelaceAmount: amount },
	});
	logger.info(`hydra: funding node ${participant.hostNodeId} with ${amount} lovelace on request`);
	return { address, balanceLovelace: balance.toString(), transferredLovelace: amount.toString() };
}
