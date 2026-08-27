/**
 * Why a node cannot act inside a head that is otherwise perfectly healthy.
 *
 * Every L2 action a participant initiates spends a script output, and a Plutus
 * spend needs a collateral input owned by the signer. That input can only come
 * from one of this wallet's own UTxOs inside the head. A participant holding
 * none can therefore lock nothing, submit nothing and collect nothing, while
 * the head reports itself open, synced and peered — because it is, and so does
 * the counterparty.
 *
 * The batch services defer and retry in this state rather than parking the
 * request for an operator, which is right: it clears by itself the moment the
 * node is topped up. But the reason reached only the log, so what an operator
 * saw was an accepted request that stayed pending against a head with no
 * errors. This turns that into a sentence.
 *
 * Pure, so the condition can be tested without a head.
 */

import { HydraHeadStatus } from '@/generated/prisma/client';

/** What the head reports about the local participant's own funds inside it. */
export type InHeadBalanceReading = {
	/** False when no live snapshot could be read, so utxoCount means nothing. */
	connected: boolean;
	/** In-head UTxOs held by the local participant's address. */
	utxoCount: number;
};

export const L2_FUNDING_BLOCK_MESSAGE =
	"This node's wallet holds no UTxOs inside the head, so it cannot build L2 transactions. " +
	'Every action from this side spends a script output and needs one of this wallet’s own in-head ' +
	'outputs for collateral. Top the head up from this node; requests already made resume on their own.';

/**
 * The blocking reason, or null when nothing is blocked or nothing is known.
 *
 * Only an Open head can answer: before that there is nothing to hold funds in,
 * and after it there is nothing left to build. A balance that could not be read
 * answers null as well — unknown, not blocked, because the connection fields
 * reported alongside this already say the head could not be reached, and a
 * confident "you have no funds" derived from no evidence would send an operator
 * to top up a head that may be fine.
 */
export function describeL2FundingBlock(status: HydraHeadStatus, balance: InHeadBalanceReading | null): string | null {
	if (status !== HydraHeadStatus.Open) return null;
	if (balance == null || !balance.connected) return null;
	if (balance.utxoCount > 0) return null;
	return L2_FUNDING_BLOCK_MESSAGE;
}
