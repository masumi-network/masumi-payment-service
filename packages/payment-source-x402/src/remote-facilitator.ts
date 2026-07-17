import createHttpError from 'http-errors';
import {
	FacilitatorResponseError,
	SettleError,
	VerifyError,
	type PaymentPayload,
	type PaymentRequirements,
	type SettleResponse,
	type VerifyResponse,
} from '@x402/core/types';
import { assertSafeFacilitatorUrl } from './internal';

// Must remain shorter than SETTLE_STALE_MS. A timed-out request is still ambiguous because the
// remote may have accepted it before the client aborted, but it cannot pin an HTTP connection or
// a live request handler until the attempt becomes operator-reconcilable.
export const REMOTE_FACILITATOR_REQUEST_TIMEOUT_MS = 120_000;

type RemoteFacilitatorOperation = 'verify' | 'settle';

const EVM_TRANSACTION_HASH_REGEX = /^0x[a-fA-F0-9]{64}$/;

function responseExcerpt(text: string, limit = 200): string {
	const compact = text.trim().replace(/\s+/g, ' ');
	if (compact === '') return '<empty response>';
	return compact.length <= limit ? compact : `${compact.slice(0, limit - 3)}...`;
}

function isOptionalObject(value: unknown): boolean {
	return value == null || (typeof value === 'object' && !Array.isArray(value));
}

function isX402Network(value: unknown): value is SettleResponse['network'] {
	return typeof value === 'string' && /^[^:]+:.+$/.test(value);
}

function parseVerifyResponse(value: unknown): VerifyResponse {
	if (typeof value !== 'object' || value == null || Array.isArray(value)) {
		throw new FacilitatorResponseError('Facilitator verify returned invalid data');
	}
	const response = value as {
		isValid?: unknown;
		invalidReason?: unknown;
		invalidMessage?: unknown;
		payer?: unknown;
		extensions?: unknown;
		extra?: unknown;
	};
	if (
		typeof response.isValid !== 'boolean' ||
		(response.invalidReason != null && typeof response.invalidReason !== 'string') ||
		(response.invalidMessage != null && typeof response.invalidMessage !== 'string') ||
		(response.payer != null && typeof response.payer !== 'string') ||
		!isOptionalObject(response.extensions) ||
		!isOptionalObject(response.extra)
	) {
		throw new FacilitatorResponseError('Facilitator verify returned invalid data');
	}
	return {
		isValid: response.isValid,
		...(typeof response.invalidReason === 'string' ? { invalidReason: response.invalidReason } : {}),
		...(typeof response.invalidMessage === 'string' ? { invalidMessage: response.invalidMessage } : {}),
		...(typeof response.payer === 'string' ? { payer: response.payer } : {}),
		...(response.extensions != null
			? { extensions: response.extensions as NonNullable<VerifyResponse['extensions']> }
			: {}),
		...(response.extra != null ? { extra: response.extra as NonNullable<VerifyResponse['extra']> } : {}),
	};
}

function parseSettleResponse(value: unknown, expectedNetwork: PaymentRequirements['network']): SettleResponse {
	if (typeof value !== 'object' || value == null || Array.isArray(value)) {
		throw new FacilitatorResponseError('Facilitator settle returned invalid data');
	}
	const response = value as {
		success?: unknown;
		errorReason?: unknown;
		errorMessage?: unknown;
		payer?: unknown;
		transaction?: unknown;
		network?: unknown;
		amount?: unknown;
		extensions?: unknown;
		extra?: unknown;
	};
	if (
		typeof response.success !== 'boolean' ||
		typeof response.transaction !== 'string' ||
		!isX402Network(response.network) ||
		(response.errorReason != null && typeof response.errorReason !== 'string') ||
		(response.errorMessage != null && typeof response.errorMessage !== 'string') ||
		(response.payer != null && typeof response.payer !== 'string') ||
		(response.amount != null && typeof response.amount !== 'string') ||
		!isOptionalObject(response.extensions) ||
		!isOptionalObject(response.extra)
	) {
		throw new FacilitatorResponseError('Facilitator settle returned invalid data');
	}
	if (response.network !== expectedNetwork) {
		throw new FacilitatorResponseError('Facilitator settle returned a different network');
	}
	if (response.success && !EVM_TRANSACTION_HASH_REGEX.test(response.transaction)) {
		throw new FacilitatorResponseError('Facilitator settle returned an invalid transaction hash');
	}
	return {
		success: response.success,
		transaction: response.transaction,
		network: response.network,
		...(typeof response.errorReason === 'string' ? { errorReason: response.errorReason } : {}),
		...(typeof response.errorMessage === 'string' ? { errorMessage: response.errorMessage } : {}),
		...(typeof response.payer === 'string' ? { payer: response.payer } : {}),
		...(typeof response.amount === 'string' ? { amount: response.amount } : {}),
		...(response.extensions != null
			? { extensions: response.extensions as NonNullable<SettleResponse['extensions']> }
			: {}),
		...(response.extra != null ? { extra: response.extra as NonNullable<SettleResponse['extra']> } : {}),
	};
}

function parseJson(text: string, operation: RemoteFacilitatorOperation): unknown {
	try {
		return JSON.parse(text);
	} catch {
		throw new FacilitatorResponseError(`Facilitator ${operation} returned invalid JSON: ${responseExcerpt(text)}`);
	}
}

export class RemoteHTTPFacilitatorClient {
	private readonly url: string;
	private readonly getAuthorizationHeader?: () => string;

	constructor(input: { url: string; getAuthorizationHeader?: () => string }) {
		assertSafeFacilitatorUrl(input.url);
		this.url = input.url.replace(/\/+$/, '');
		this.getAuthorizationHeader = input.getAuthorizationHeader;
	}

	private async request(
		operation: 'verify',
		paymentPayload: PaymentPayload,
		paymentRequirements: PaymentRequirements,
	): Promise<VerifyResponse>;
	private async request(
		operation: 'settle',
		paymentPayload: PaymentPayload,
		paymentRequirements: PaymentRequirements,
	): Promise<SettleResponse>;
	private async request(
		operation: RemoteFacilitatorOperation,
		paymentPayload: PaymentPayload,
		paymentRequirements: PaymentRequirements,
	): Promise<VerifyResponse | SettleResponse> {
		// Validate again immediately before every network call. This rejects unsafe legacy rows even
		// if an instance was retained across a future configuration-validation regression.
		assertSafeFacilitatorUrl(this.url);
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), REMOTE_FACILITATOR_REQUEST_TIMEOUT_MS);
		timeout.unref();
		try {
			const authorization = this.getAuthorizationHeader?.();
			const response = await fetch(`${this.url}/${operation}`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					...(authorization != null ? { Authorization: authorization } : {}),
				},
				// Do not forward credentials or signed payloads across redirects, and do not let a
				// public hostname redirect around the literal-host SSRF guard.
				redirect: 'error',
				signal: controller.signal,
				body: JSON.stringify(
					{
						x402Version: paymentPayload.x402Version,
						paymentPayload,
						paymentRequirements,
					},
					(_key: string, value: unknown): unknown => (typeof value === 'bigint' ? value.toString() : value),
				),
			});
			const text = await response.text();
			const data = parseJson(text, operation);
			if (!response.ok) {
				if (operation === 'verify') {
					throw new VerifyError(response.status, parseVerifyResponse(data));
				}
				throw new SettleError(response.status, parseSettleResponse(data, paymentRequirements.network));
			}
			return operation === 'verify'
				? parseVerifyResponse(data)
				: parseSettleResponse(data, paymentRequirements.network);
		} catch (error) {
			if (controller.signal.aborted) {
				throw createHttpError(504, `x402 remote facilitator ${operation} timed out`);
			}
			throw error;
		} finally {
			clearTimeout(timeout);
		}
	}

	verify(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): Promise<VerifyResponse> {
		return this.request('verify', paymentPayload, paymentRequirements);
	}

	settle(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): Promise<SettleResponse> {
		return this.request('settle', paymentPayload, paymentRequirements);
	}
}
