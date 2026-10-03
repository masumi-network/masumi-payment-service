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
 * This is a *transfer*, not a shared key. ADR 0015 §3 keeps the node's
 * infrastructure key separate from the custodial funding wallet so that a
 * compromised host cannot reach escrowed funds; funding it by moving a small,
 * bounded amount preserves that.
 *
 * Distinct from the Hydra top-up in `hydra-low-balance/auto-topup`, which
 * commits funds *into an already-open head* on L2. This runs before that is
 * possible, on L1, and against a different address.
 */

import { HydraHeadStatus, HydraInviteStatus, Prisma, TransactionStatus } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { withSerializableSlotRetry } from '@masumi/payment-core/serializable-semaphore';
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
 *
 * Raised for partial fanout. A head holding more UTxOs than fit in one
 * transaction empties over several, each a script spend carrying a BLS
 * accumulator membership proof, and each paid for out of this key. How many
 * steps a head needs is not knowable in advance — it depends on how much the
 * head accumulated — so this is deliberate headroom rather than a measured
 * figure, and the reason the floor is generous instead of tight.
 *
 * Running dry mid-chain is recoverable rather than fatal: the fanout can be
 * asked for again once the key is funded, and the refusal is recorded against
 * the head as a NotEnoughFuel error rather than passing silently. Headroom is
 * what keeps that from being something an operator has to notice at all.
 */
export const NODE_MINIMUM_LOVELACE = 15_000_000n;

/** Topped up to this, so a node is not refunded every cycle for a few lovelace. */
export const NODE_TARGET_LOVELACE = 30_000_000n;

/** Bounded so one bad cycle cannot drain a funding wallet. */
const MAX_TOPUPS_PER_CYCLE = 5;

/**
 * How long a transfer counts as still in flight after it stops being Pending.
 *
 * Guarding on Pending alone was not enough. A transfer confirms in our database
 * a little before the chain indexer reflects it, and inside that gap the guard
 * sees nothing pending and the balance still reads zero, so a second transfer
 * goes out. Every node opened so far was funded twice, fifty seconds apart, for
 * exactly this reason.
 *
 * Generous on purpose: paying a node twice costs real ADA, while waiting a few
 * extra minutes to top up a node that is already funded costs nothing.
 */
const RECENT_TRANSFER_WINDOW_MS = 15 * 60 * 1000;
/**
 * How long a failed transfer stops another being created for the same node.
 *
 * `recentlySentTo` deliberately ignores terminal statuses, because a transfer
 * that definitively did not happen must not block the retry that replaces it.
 * That is right for one retry and wrong for a loop: the funding cycle runs
 * every ten seconds, so a shortfall the funding wallet cannot cover — it is out
 * of ADA, the build throws before broadcast — created a `WalletFundTransfer`
 * row per tick, thousands a day per node, and claimed and released the
 * participant's hot wallet on every submitter pass while the V2 batcher was
 * selecting on the same lock. The retry still happens; it happens once a
 * minute instead of six times.
 */
const FAILED_TRANSFER_COOLDOWN_MS = 60 * 1000;

/**
 * Anything sent to this address that may still land.
 *
 * Terminal failures are excluded: a transfer that definitively did not happen
 * must not block the retry that replaces it.
 *
 * The two live statuses are bounded differently, and deliberately. A `Pending`
 * transfer has not been submitted yet, so age tells us nothing about it — the
 * submitter only picks up rows whose hot wallet is free, and that wallet is the
 * same one doing this head's L2 locks and batch payments, so it is routinely
 * busy for far longer than the window. Bounding `Pending` by age meant a
 * transfer that had been waiting sixteen minutes stopped counting, a second
 * 30 ADA transfer was created, then a third, and every one of them submitted at
 * once when the wallet finally came free. Only `Confirmed` needs the window,
 * for the gap between our own confirmation and the chain indexer reflecting it.
 */
export function recentlySentTo() {
	// Measured from the confirmation, not from the row's creation. The two are
	// far apart for exactly the reason the paragraph above gives: the submitter
	// waits for a hot wallet that is busy doing this head's L2 work, so a
	// transfer routinely sits `Pending` for longer than the whole window and is
	// already outside it the instant it confirms. That put the indexing gap back
	// where it started — the next cycle reads a zero balance, sees nothing in
	// flight and sends a second 30 ADA — and worse, `withdrawNodeFunds` shares
	// this helper: a sweep in that gap reports `dust`, which is a settled code,
	// and the participant and its only signing key are deleted while 30 ADA is
	// still on its way to the node's address.
	const cutoff = new Date(Date.now() - RECENT_TRANSFER_WINDOW_MS);
	return {
		OR: [
			{ status: TransactionStatus.Pending },
			{
				status: TransactionStatus.Confirmed,
				// `createdAt` remains the fallback for a row confirmed by a path that
				// never stamped `lastCheckedAt`.
				OR: [{ lastCheckedAt: { gte: cutoff } }, { lastCheckedAt: null, createdAt: { gte: cutoff } }],
			},
		],
	};
}

/**
 * Claim the right to fund one node, or decline.
 *
 * Checking for a recent transfer and then creating one are two statements, and
 * between them a second caller can pass the same check: the funding cycle and an
 * on-demand `fundHydraNodeNow` run from different callers entirely. Serializable
 * makes the pair atomic, so exactly one of them writes and the other sees the
 * transfer it would have duplicated.
 */
async function claimFunding(args: {
	hotWalletId: string;
	address: string;
	amount: bigint;
	/**
	 * Whether a recent failure blocks this claim.
	 *
	 * Set by the unattended cycle and not by the operator's own "Send": damping
	 * exists to stop a loop rebuilding a doomed transfer every ten seconds, and
	 * an operator asking for one has already decided to try again.
	 */
	respectFailureCooldown: boolean;
}): Promise<'claimed' | 'already-in-flight' | 'recently-failed'> {
	return await withSerializableSlotRetry(() =>
		prisma.$transaction(
			async (tx) => {
				const inFlight = await tx.walletFundTransfer.findFirst({
					where: { toAddress: args.address, ...recentlySentTo() },
				});
				if (inFlight !== null) return 'already-in-flight' as const;

				// Damping, not a second in-flight check: a failure leaves nothing in
				// flight, so without this the cycle rebuilds the same doomed transfer
				// every ten seconds forever.
				if (args.respectFailureCooldown) {
					const recentFailure = await tx.walletFundTransfer.findFirst({
						where: {
							toAddress: args.address,
							status: { in: [TransactionStatus.FailedViaManualReset, TransactionStatus.RolledBack] },
							updatedAt: { gte: new Date(Date.now() - FAILED_TRANSFER_COOLDOWN_MS) },
						},
					});
					if (recentFailure !== null) return 'recently-failed' as const;
				}

				await tx.walletFundTransfer.create({
					data: { hotWalletId: args.hotWalletId, toAddress: args.address, lovelaceAmount: args.amount },
				});
				return 'claimed' as const;
			},
			{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
		),
	);
}

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
			// The opt-out, honoured where the money actually moves. `autoFund: false`
			// was accepted at the invite and then read by nothing, so this cycle sent
			// the target balance to a node whose operator had said they fund that key
			// themselves — within a tick of minting the invite.
			autoFund: true,
			OR: [
				// Every head but a finished one. A node stops needing fuel the moment
				// its head reaches Final — that is exactly when sweeping it is
				// allowed — and funding one that has been swept re-sends the target
				// balance to a dead node, which the operator sweeps again, at two L1
				// fees per round for as long as both keep running. The status was
				// already being selected; it was simply never consulted.
				{ HydraHead: { status: { not: HydraHeadStatus.Final } } },
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

		outcome.checked += 1;
		const balance = await readLovelaceAt(
			address,
			network,
			participant.Wallet.PaymentSource.PaymentSourceConfig.rpcProviderApiKey,
		);
		if (balance === null || balance >= NODE_MINIMUM_LOVELACE) {
			continue;
		}

		// Claimed atomically rather than checked and then written: this cycle and an
		// on-demand `fundHydraNodeNow` are different callers, and between a separate
		// check and create both can pass. See `claimFunding`.
		const amount = NODE_TARGET_LOVELACE - balance;
		const claim = await claimFunding({
			hotWalletId: participant.walletId,
			address,
			amount,
			respectFailureCooldown: true,
		});
		if (claim !== 'claimed') {
			outcome.skipped += 1;
			continue;
		}
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
 * What a funding request actually did.
 *
 * `sufficient` and `in-flight` both transfer nothing, and they mean opposite
 * things to the operator: one says the node is ready, the other says its money
 * has not arrived yet and no second transfer will be sent while the first is
 * outstanding.
 */
export type NodeFundingRequestOutcome = 'sent' | 'sufficient' | 'in-flight';

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
	// Written out rather than aliased: express-zod-api compares the handler's
	// return against the literal union the response schema produces.
	outcome: 'sent' | 'sufficient' | 'in-flight';
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
		return { address, balanceLovelace: balance.toString(), transferredLovelace: null, outcome: 'sufficient' };
	}

	// The same one-in-flight rule the cycle applies, for the same reason: the
	// balance does not move until a transfer confirms, so anything asking again
	// inside that window sees zero and pays again. Redeeming an invite funds the
	// node immediately and the cycle funds it too, which is exactly this window —
	// it sent 10 ADA twice to every node opened so far.
	const amount = NODE_TARGET_LOVELACE - balance;
	const claim = await claimFunding({
		hotWalletId: participant.walletId,
		address,
		amount,
		respectFailureCooldown: false,
	});
	// Reported apart from `sufficient`, not folded into a null transfer. Both
	// outcomes send nothing, and the callers all read that as "already funded" —
	// so a node holding zero, whose first transfer is stuck behind a hot wallet
	// that stays Pending for as long as it is doing L2 work, was announced as
	// `Already funded, holding 0.00 tADA`. The operator then retries Init, gets
	// `NoSeedInput`, and comes back to the same sentence.
	if (claim === 'already-in-flight') {
		return { address, balanceLovelace: balance.toString(), transferredLovelace: null, outcome: 'in-flight' };
	}

	logger.info(`hydra: funding node ${participant.hostNodeId} with ${amount} lovelace on request`);
	return { address, balanceLovelace: balance.toString(), transferredLovelace: amount.toString(), outcome: 'sent' };
}
