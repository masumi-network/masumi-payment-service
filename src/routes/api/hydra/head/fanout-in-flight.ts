/**
 * Heads with a Fanout or PartialFanout on the wire from this process.
 *
 * hydra-node's refusal of a fanout command names only the command, and a failed
 * post of any fanout step rejects every fanout waiter. With two in flight, the
 * failure of one fails the other, even when that one landed. So one fanout
 * command per head is sent at a time: a second request is refused, and the
 * first one reports what happened.
 */
export const fanoutsInFlight = new Set<string>();
