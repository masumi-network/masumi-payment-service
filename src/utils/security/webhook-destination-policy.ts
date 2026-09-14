import { createHash } from 'node:crypto';
import {
	isBlockedIpAddress,
	isUnresolvableHostnameError,
	resolveHostnameAddresses,
	type ResolvedAddress,
} from '@masumi/payment-core/ssrf-guard';

export const WEBHOOK_DESTINATION_NOT_ALLOWED_MESSAGE = 'Webhook destination is not allowed';
export const WEBHOOK_DELIVERY_BLOCKED_MESSAGE = 'Delivery blocked by policy';

export class WebhookDestinationPolicyError extends Error {
	constructor(public readonly reason: string) {
		super(reason);
		this.name = 'WebhookDestinationPolicyError';
	}
}

export const isWebhookDestinationPolicyError = (error: unknown): error is WebhookDestinationPolicyError =>
	error instanceof WebhookDestinationPolicyError;

const isBlockedAddress = ({ address, family }: ResolvedAddress): boolean => isBlockedIpAddress(address, family);

export const assertWebhookDestinationAllowed = async (rawUrl: string): Promise<URL> => {
	let parsedUrl: URL;
	try {
		parsedUrl = new URL(rawUrl);
	} catch {
		throw new WebhookDestinationPolicyError('Webhook destination URL is invalid');
	}

	if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
		throw new WebhookDestinationPolicyError('Webhook destinations must use http or https');
	}

	if (parsedUrl.hostname.length === 0) {
		throw new WebhookDestinationPolicyError('Webhook destination host is required');
	}

	if (parsedUrl.username.length > 0 || parsedUrl.password.length > 0) {
		throw new WebhookDestinationPolicyError('Webhook destinations must not contain userinfo');
	}

	let resolvedAddresses: ResolvedAddress[];
	try {
		resolvedAddresses = await resolveHostnameAddresses(parsedUrl.hostname);
	} catch (error) {
		if (isUnresolvableHostnameError(error)) {
			throw new WebhookDestinationPolicyError(error.message);
		}
		throw new WebhookDestinationPolicyError('Webhook destination could not be resolved');
	}

	if (resolvedAddresses.some(isBlockedAddress)) {
		throw new WebhookDestinationPolicyError('Webhook destination resolved to a blocked address');
	}

	return parsedUrl;
};

export const redactWebhookDestination = (rawUrl: string): string => {
	const suffix = createHash('sha256').update(rawUrl).digest('hex').slice(0, 8);

	try {
		const parsedUrl = new URL(rawUrl);
		return `${parsedUrl.protocol}//${parsedUrl.host}#${suffix}`;
	} catch {
		return `invalid-url#${suffix}`;
	}
};
