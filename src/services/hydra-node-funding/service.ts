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

import { TransactionStatus } from '@/generated/prisma/client';
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

async function readLovelaceAt(address: string, network: 'Preprod' | 'Mainnet', apiKey: string): Promise<bigint | null> {
	try {
		const blockfrost = getBlockfrostInstance(network, apiKey);
		const details = await blockfrost.addressesExtended(address);
		const lovelace = details.amount.find((entry) => entry.unit === 'lovelace');
		return BigInt(lovelace?.quantity ?? '0');
	} catch (error) {
		const message = (error as Error).message;
		// A never-used address has no record at all. That is zero, not a failure —
		// and it is the state every newly provisioned node starts in, so treating
		// it as an error would mean never funding the nodes that need it most.
		if (/404|not found/i.test(message)) {
			return 0n;
		}
		logger.warn(`hydra: could not read the balance of node address ${address}: ${message}`);
		return null;
	}
}

/**
 * One pass over the nodes that could need funding.
 *
 * Only participants bound to a head are considered. An unbound participant
 * belongs to an invite nobody has redeemed yet, and its node cannot open
 * anything — funding it would tie up ADA in a reservation that may be revoked.
 */
export async function runHydraNodeFundingCycle(): Promise<NodeFundingOutcome> {
	const participants = await prisma.hydraLocalParticipant.findMany({
		where: { hydraHeadId: { not: null } },
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

		// One in-flight transfer per node. The transfer takes a while to confirm,
		// and the balance does not move until it does — without this every cycle
		// in that window would queue another.
		const inFlight = await prisma.walletFundTransfer.findFirst({
			where: {
				toAddress: address,
				status: { in: [TransactionStatus.Pending, TransactionStatus.Confirmed] },
				txHash: null,
			},
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

	const amount = NODE_TARGET_LOVELACE - balance;
	await prisma.walletFundTransfer.create({
		data: { hotWalletId: participant.walletId, toAddress: address, lovelaceAmount: amount },
	});
	logger.info(`hydra: funding node ${participant.hostNodeId} with ${amount} lovelace on request`);
	return { address, balanceLovelace: balance.toString(), transferredLovelace: amount.toString() };
}
