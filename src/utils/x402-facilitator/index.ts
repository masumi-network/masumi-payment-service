import createHttpError from 'http-errors';
import { logger } from '@/utils/logger';

export interface Eip3009Authorization {
	from: string;
	to: string;
	value: string;
	validAfter: string;
	validBefore: string;
	nonce: string;
}

export interface FacilitatorSettleResult {
	settlementId: string;
	xPaymentHeader: string;
}

interface FacilitatorSettleResponse {
	settlementId?: string;
	id?: string;
	xPayment?: string;
	x_payment?: string;
	header?: string;
}

/**
 * Calls the x402 facilitator /settle endpoint with an EIP-3009 signed authorization.
 * Returns the settlementId and the X-PAYMENT header value for use with the protected API.
 */
export async function settleX402Payment(opts: {
	facilitatorUrl: string;
	scheme: string;
	network: string;
	authorization: Eip3009Authorization;
	signature: string;
}): Promise<FacilitatorSettleResult> {
	const { facilitatorUrl, scheme, network, authorization, signature } = opts;

	const url = `${facilitatorUrl.replace(/\/$/, '')}/settle`;

	const body = {
		x402Version: 1,
		scheme,
		network,
		payload: {
			authorization,
			signature,
		},
	};

	let response: Response;
	try {
		response = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(15_000),
		});
	} catch (err) {
		logger.error('x402 facilitator network error during settle', { url, error: err });
		throw createHttpError(502, 'x402 facilitator unreachable');
	}

	if (!response.ok) {
		let detail = '';
		try {
			detail = await response.text();
		} catch {
			// ignore read error
		}
		logger.error('x402 facilitator settle returned error', { url, status: response.status, detail });
		throw createHttpError(502, `x402 facilitator settle failed (status ${response.status})`);
	}

	let json: FacilitatorSettleResponse;
	try {
		json = (await response.json()) as FacilitatorSettleResponse;
	} catch (err) {
		logger.error('x402 facilitator settle returned non-JSON body', { url, error: err });
		throw createHttpError(502, 'x402 facilitator returned invalid response');
	}

	const settlementId = json.settlementId ?? json.id ?? '';
	const xPaymentHeader = json.xPayment ?? json.x_payment ?? json.header ?? '';

	if (!xPaymentHeader) {
		logger.error('x402 facilitator settle response missing payment header', { url, json });
		throw createHttpError(502, 'x402 facilitator did not return a payment header');
	}

	return { settlementId, xPaymentHeader };
}
