import { createHmac } from 'node:crypto';

/**
 * The credential that reaches one node, and no other.
 *
 * The Host's user token is a single value for the whole Host, so anyone holding
 * it can send a node any command, Close and Fanout included, and the proxy
 * passes WebSocket bytes through unread. The payment service sends those very
 * commands, so the answer is not to forbid them but to narrow whom they reach:
 * the service presents this derived value instead, which opens only the node it
 * was derived for and cannot be turned back into the token behind it.
 *
 * Derived rather than issued, so there is nothing to store, nothing to
 * provision, and a node that already exists has its token the moment this ships.
 * Both Host tokens work as the secret: a service registered without a user token
 * keeps the admin token in its runtime slot, and deriving from it keeps the admin
 * token itself off the runtime path.
 *
 * The payment service holds a copy of this function and a spec that pins both to
 * the same bytes; change one and change the other.
 */
const CONTEXT = 'masumi-hydra-host/node-token/v1:';

export function deriveNodeToken(secret: string, nodeId: string): string {
	return createHmac('sha256', secret).update(`${CONTEXT}${nodeId}`, 'utf8').digest('hex');
}
