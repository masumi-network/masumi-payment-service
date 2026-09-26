import createHttpError from 'http-errors';
import { CONFIG } from '@masumi/payment-core/config';
import { logger } from '@masumi/payment-core/logger';
import { z } from '@masumi/payment-core/zod';

const READ_TOKEN_TIMEOUT_MS = 10_000;

const exchainReadTokenReply = z.object({
	token: z.string().min(16),
	expiresAt: z.string().min(1),
});

/**
 * Mint a read token for the embedded Exchain page (MAS-596 demo).
 *
 * The node token authenticates us to Exchain and stays on this server. What
 * leaves it is Exchain's read token: read-only, scoped to one wallet, valid for
 * 15 minutes, and meant to sit in the frame URL. The API base is the same
 * origin the CSP allows the admin UI to frame, so the two cannot drift apart.
 */
export async function mintExchainReadToken() {
	const origin = CONFIG.EXCHAIN_DASHBOARD_ORIGIN;
	const nodeToken = CONFIG.EXCHAIN_NODE_TOKEN;
	const walletId = CONFIG.EXCHAIN_WALLET_ID;
	if (origin == null || nodeToken == null || walletId == null) {
		throw createHttpError(503, 'Exchain co-signing is not configured on this node');
	}

	let response: Response;
	try {
		response = await fetch(`${origin}/v1/wallets/${walletId}/read-token`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${nodeToken}` },
			// Never replay the node token to wherever a redirect points.
			redirect: 'error',
			signal: AbortSignal.timeout(READ_TOKEN_TIMEOUT_MS),
		});
	} catch (error) {
		logger.warn('Exchain read-token request failed', { error: error instanceof Error ? error.message : String(error) });
		throw createHttpError(502, 'Could not reach Exchain');
	}
	if (response.status !== 200 && response.status !== 201) {
		logger.warn('Exchain refused the read-token request', { status: response.status });
		throw createHttpError(502, `Exchain refused the read-token request (HTTP ${response.status})`);
	}
	const reply = exchainReadTokenReply.safeParse(await response.json().catch(() => null));
	if (!reply.success) {
		throw createHttpError(502, 'Exchain returned an unexpected read-token reply');
	}

	const { token, expiresAt } = reply.data;
	return {
		walletId,
		url: `${origin}/protected/${walletId}?t=${encodeURIComponent(token)}`,
		token,
		expiresAt,
	};
}
