import { createHmac } from 'node:crypto';

/** Keep this byte-for-byte compatible with the Host's derived node token. */
const NODE_TOKEN_CONTEXT = 'masumi-hydra-host/node-token/v1:';

export function deriveHostNodeToken(secret: string, nodeId: string): string {
	return createHmac('sha256', secret).update(`${NODE_TOKEN_CONTEXT}${nodeId}`, 'utf8').digest('hex');
}
