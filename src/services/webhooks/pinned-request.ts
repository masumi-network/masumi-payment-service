import { request as httpRequest, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { ResolvedAddress } from '@masumi/payment-core/ssrf-guard';

type PinnedDestination = {
	url: URL;
	addresses: ResolvedAddress[];
};

type WebhookRequest = {
	headers: Record<string, string>;
	body: string;
};

type WebhookResponse = {
	ok: boolean;
	status: number;
	statusText: string;
};

export const postPinnedWebhook = async (
	destination: PinnedDestination,
	request: WebhookRequest,
	signal: AbortSignal,
): Promise<WebhookResponse> => {
	const { url, addresses } = destination;
	const pinnedAddress = addresses[0];
	if (pinnedAddress == null) {
		throw new Error('Webhook destination has no validated address');
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Error('Webhook destination must use HTTP or HTTPS');
	}

	const requestOptions: RequestOptions & { autoSelectFamily: boolean } = {
		agent: false,
		autoSelectFamily: true,
		method: 'POST',
		headers: { ...request.headers, 'Content-Length': Buffer.byteLength(request.body).toString() },
		signal,
		// The URL supplies Host and TLS identity. Only the checked IPs reach the socket.
		lookup: (_hostname, lookupOptions, callback) => {
			if (lookupOptions.all) callback(null, addresses);
			else callback(null, pinnedAddress.address, pinnedAddress.family);
		},
	};
	const sendRequest = url.protocol === 'https:' ? httpsRequest : httpRequest;

	return new Promise((resolve, reject) => {
		const clientRequest = sendRequest(url, requestOptions, (response) => {
			const status = response.statusCode ?? 0;
			resolve({
				ok: status >= 200 && status < 300,
				status,
				statusText: response.statusMessage ?? '',
			});
			response.destroy();
		});
		clientRequest.once('error', reject);
		clientRequest.once('upgrade', (_response, socket) => {
			socket.destroy();
			reject(new Error('Webhook protocol upgrades are not allowed'));
		});
		clientRequest.end(request.body);
	});
};
