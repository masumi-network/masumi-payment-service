import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ClientRequest } from 'node:http';
import type { RequestOptions } from 'node:https';

const mockResolveWebhookDestinationAllowed = jest.fn() as jest.Mock<any>;

class TestWebhookDestinationPolicyError extends Error {
	constructor(public readonly reason: string) {
		super(reason);
		this.name = 'WebhookDestinationPolicyError';
	}
}

jest.unstable_mockModule('@/utils/security/webhook-destination-policy', () => ({
	resolveWebhookDestinationAllowed: mockResolveWebhookDestinationAllowed,
	isWebhookDestinationPolicyError: jest.fn((error: unknown) => error instanceof TestWebhookDestinationPolicyError),
}));

const VALID_CARD = {
	protocolVersions: ['1.0'],
	name: 'Test Agent',
	description: 'A test agent',
	version: '1.0.0',
	supportedInterfaces: [{ url: 'https://agent.example/a2a', protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' }],
	capabilities: {},
	defaultInputModes: ['text/plain'],
	defaultOutputModes: ['text/plain'],
	skills: [
		{
			id: 'skill-1',
			name: 'Skill',
			description: 'desc',
			tags: ['tag'],
			inputModes: ['text/plain'],
			outputModes: ['text/plain'],
		},
	],
};

const mockRequest = jest.fn<typeof import('node:https').request>();

const originalHttps = await import('node:https');
jest.unstable_mockModule('node:https', () => ({ ...originalHttps, request: mockRequest }));

const { agentCardSchema, validateA2AAgentCardOrThrow, AGENT_CARD_FETCH_TIMEOUT_MS, AGENT_CARD_MAX_BYTES } =
	await import('./agent-card');

let lastResponse: IncomingMessage;
let lastRequest: ClientRequest;
function mockResponse(
	body: unknown,
	init?: { status?: number; contentType?: string; contentLength?: string; rawBody?: string },
) {
	mockRequest.mockImplementation((...args: any[]) => {
		const callback = args[2] as (response: IncomingMessage) => void;
		const options = args[1] as RequestOptions;
		const req = new EventEmitter() as ClientRequest;
		req.destroy = jest.fn(() => req);
		req.end = jest.fn(() => {
			const response = new PassThrough() as unknown as IncomingMessage;
			response.statusCode = init?.status ?? 200;
			response.headers = { 'content-type': init?.contentType ?? 'application/json' };
			if (init?.contentLength) response.headers['content-length'] = init.contentLength;
			lastResponse = response;
			callback(response);
			(response as unknown as PassThrough).end(init?.rawBody ?? JSON.stringify(body));
			return req;
		}) as ClientRequest['end'];
		options.signal?.addEventListener('abort', () => {
			lastResponse?.destroy(new Error('aborted'));
			req.emit('error', new Error('aborted'));
		});
		lastRequest = req;
		return req;
	});
}

describe('agentCardSchema', () => {
	it('bounds protocol membership work linearly for a large valid card', () => {
		const versionCount = 512;
		const maxMembershipChecks = versionCount * 4;
		const protocolVersions = Array.from({ length: versionCount }, (_, index) => `${index}.0`);
		const card = {
			...VALID_CARD,
			protocolVersions,
			supportedInterfaces: protocolVersions.map((protocolVersion) => ({
				...VALID_CARD.supportedInterfaces[0],
				protocolVersion,
			})),
		};
		let membershipChecks = 0;
		const originalSome = Array.prototype.some;
		const originalIncludes = Array.prototype.includes;
		const someSpy = jest.spyOn(Array.prototype, 'some').mockImplementation(function (
			this: Array<{ protocolVersion?: string }>,
			callback,
			thisArg,
		) {
			const isInterfaceList = this.length === versionCount && this[0]?.protocolVersion === '0.0';
			return originalSome.call(this, (value, index, values) => {
				if (isInterfaceList) membershipChecks++;
				return callback.call(thisArg, value, index, values);
			});
		});
		const includesSpy = jest.spyOn(Array.prototype, 'includes').mockImplementation(function (
			this: unknown[],
			value,
			fromIndex,
		) {
			if (this.length === versionCount && this[0] === '0.0') {
				for (let index = fromIndex ?? 0; index < this.length; index++) {
					membershipChecks++;
					if (this[index] === value) break;
				}
			}
			return originalIncludes.call(this, value, fromIndex);
		});
		const originalHas = Set.prototype.has;
		const hasSpy = jest.spyOn(Set.prototype, 'has').mockImplementation(function (this: Set<unknown>, value) {
			if (typeof value === 'string' && /^[0-9]+\.0$/.test(value)) membershipChecks++;
			return originalHas.call(this, value);
		});
		let parsed: ReturnType<typeof agentCardSchema.safeParse>;
		try {
			parsed = agentCardSchema.safeParse(card);
		} finally {
			someSpy.mockRestore();
			includesSpy.mockRestore();
			hasSpy.mockRestore();
		}
		expect(parsed.success).toBe(true);
		expect(membershipChecks).toBeGreaterThanOrEqual(versionCount * 2);
		expect(membershipChecks).toBeLessThanOrEqual(maxMembershipChecks);
	});

	it('rejects a top-level version without a matching interface', () => {
		expect(agentCardSchema.safeParse({ ...VALID_CARD, protocolVersions: ['1.0', '9.9'] }).success).toBe(false);
	});

	it.each(['1', '1.0.0', '€'.repeat(22), '1.０'])('rejects invalid protocol version %s', (version) => {
		const card = {
			...VALID_CARD,
			protocolVersions: [version],
			supportedInterfaces: [{ ...VALID_CARD.supportedInterfaces[0], protocolVersion: version }],
		};
		expect(agentCardSchema.safeParse(card).success).toBe(false);
	});

	it('accepts a valid MIP-002 agent card', () => {
		expect(agentCardSchema.safeParse(VALID_CARD).success).toBe(true);
	});

	it('rejects a card missing a required field', () => {
		const { name: _name, ...withoutName } = VALID_CARD;
		expect(agentCardSchema.safeParse(withoutName).success).toBe(false);
	});

	it('rejects a non-https supportedInterfaces[].url', () => {
		const card = {
			...VALID_CARD,
			supportedInterfaces: [{ ...VALID_CARD.supportedInterfaces[0], url: 'http://agent.example/a2a' }],
		};
		expect(agentCardSchema.safeParse(card).success).toBe(false);
	});

	it('rejects an empty skills array', () => {
		expect(agentCardSchema.safeParse({ ...VALID_CARD, skills: [] }).success).toBe(false);
	});

	it('rejects a supportedInterfaces[].protocolVersion absent from protocolVersions', () => {
		const card = {
			...VALID_CARD,
			supportedInterfaces: [{ ...VALID_CARD.supportedInterfaces[0], protocolVersion: '2.0' }],
		};
		expect(agentCardSchema.safeParse(card).success).toBe(false);
	});
});

describe('validateA2AAgentCardOrThrow', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockResolveWebhookDestinationAllowed.mockImplementation(async (url: string) => ({
			url: new URL(url),
			addresses: [{ address: '93.184.216.34', family: 4 }],
		}));
		mockResponse(VALID_CARD);
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	it('passes for a valid https agent card matching declared protocol versions', async () => {
		await expect(
			validateA2AAgentCardOrThrow('https://agent.example/.well-known/agent-card.json', ['1.0']),
		).resolves.toBeUndefined();
	});

	it('rejects a non-https url without paying for a DNS-resolving SSRF check', async () => {
		await expect(
			validateA2AAgentCardOrThrow('http://agent.example/.well-known/agent-card.json', ['1.0']),
		).rejects.toThrow('must use https');
		expect(mockResolveWebhookDestinationAllowed).not.toHaveBeenCalled();
	});

	it('rejects when the SSRF guard blocks the destination', async () => {
		mockResolveWebhookDestinationAllowed.mockRejectedValue(
			new TestWebhookDestinationPolicyError('resolved to a blocked address'),
		);
		await expect(validateA2AAgentCardOrThrow('https://blocked.example/agent-card.json', ['1.0'])).rejects.toThrow(
			'A2A agent card URL rejected',
		);
	});

	it('rejects a non-JSON content-type', async () => {
		mockResponse(VALID_CARD, { contentType: 'text/html' });
		await expect(
			validateA2AAgentCardOrThrow('https://agent.example/.well-known/agent-card.json', ['1.0']),
		).rejects.toThrow('was not application/json');
	});

	it('rejects a non-2xx fetch status', async () => {
		mockResponse(VALID_CARD, { status: 404 });
		await expect(
			validateA2AAgentCardOrThrow('https://agent.example/.well-known/agent-card.json', ['1.0']),
		).rejects.toThrow('status 404');
	});

	it('rejects a raw network failure as a 400, not an unhandled 500', async () => {
		mockRequest.mockImplementation(() => {
			throw new Error('ECONNREFUSED');
		});
		await expect(
			validateA2AAgentCardOrThrow('https://agent.example/.well-known/agent-card.json', ['1.0']),
		).rejects.toMatchObject({ status: 400, message: expect.stringContaining('Could not fetch A2A agent card') });
	});

	it('rejects a response exceeding the size cap (content-length)', async () => {
		mockResponse(VALID_CARD, { contentLength: String(AGENT_CARD_MAX_BYTES + 1) });
		await expect(
			validateA2AAgentCardOrThrow('https://agent.example/.well-known/agent-card.json', ['1.0']),
		).rejects.toThrow('exceeds the maximum allowed size');
	});

	it('rejects UTF-8 bytes exceeding the cap even with fewer characters', async () => {
		mockResponse({ ...VALID_CARD, description: '€'.repeat(400_000) });
		await expect(validateA2AAgentCardOrThrow('https://agent.example/agent-card.json', ['1.0'])).rejects.toThrow(
			'exceeds the maximum allowed size',
		);
	});

	it('rejects a schema-invalid card', async () => {
		mockResponse({ name: 'x' });
		await expect(
			validateA2AAgentCardOrThrow('https://agent.example/.well-known/agent-card.json', ['1.0']),
		).rejects.toThrow('A2A agent card is invalid');
	});

	it('rejects when a declared protocol version is absent from the fetched card', async () => {
		await expect(
			validateA2AAgentCardOrThrow('https://agent.example/.well-known/agent-card.json', ['9.9']),
		).rejects.toThrow('does not support declared protocol version');
	});

	it('tries the next checked address after a connection failure', async () => {
		mockResolveWebhookDestinationAllowed.mockResolvedValue({
			url: new URL('https://agent.example/card'),
			addresses: [
				{ address: '2606:4700::1111', family: 6 },
				{ address: '93.184.216.34', family: 4 },
			],
		});
		mockRequest.mockImplementationOnce(() => {
			const req = new EventEmitter() as ClientRequest;
			req.end = jest.fn(() => {
				req.emit('error', new Error('ENETUNREACH'));
				return req;
			}) as ClientRequest['end'];
			return req;
		});
		await expect(validateA2AAgentCardOrThrow('https://agent.example/card', ['1.0'])).resolves.toBeUndefined();
		expect(mockRequest).toHaveBeenCalledTimes(2);
		const options = mockRequest.mock.calls[1][1] as RequestOptions;
		const callback = jest.fn();
		(options.lookup as Function)('agent.example', {}, callback);
		expect(callback).toHaveBeenCalledWith(null, '93.184.216.34', 4);
		expect(mockResolveWebhookDestinationAllowed).toHaveBeenCalledTimes(1);
	});

	it('pins the validated address while retaining the original TLS hostname', async () => {
		await validateA2AAgentCardOrThrow('https://agent.example/card', ['1.0']);
		const [url, options] = mockRequest.mock.calls[0] as [URL, RequestOptions & { autoSelectFamily: boolean }];
		expect(url.hostname).toBe('agent.example');
		expect(options.agent).toBe(false);
		expect(options.autoSelectFamily).toBe(false);
		const callback = jest.fn();
		(options.lookup as Function)('agent.example', {}, callback);
		expect(callback).toHaveBeenCalledWith(null, '93.184.216.34', 4);
	});

	it('rejects redirects without following them', async () => {
		mockResolveWebhookDestinationAllowed.mockResolvedValue({
			url: new URL('https://agent.example/card'),
			addresses: [
				{ address: '93.184.216.34', family: 4 },
				{ address: '2606:4700::1111', family: 6 },
			],
		});
		mockResponse(VALID_CARD, { status: 302 });
		await expect(validateA2AAgentCardOrThrow('https://agent.example/card', ['1.0'])).rejects.toThrow('status 302');
		expect(mockRequest).toHaveBeenCalledTimes(1);
		expect(lastResponse.destroyed).toBe(true);
	});

	it('stops an oversized stream and destroys the connection', async () => {
		mockResponse(VALID_CARD, { rawBody: 'x'.repeat(AGENT_CARD_MAX_BYTES + 1) });
		await expect(validateA2AAgentCardOrThrow('https://agent.example/card', ['1.0'])).rejects.toThrow(
			'exceeds the maximum allowed size',
		);
		expect(lastResponse.destroyed).toBe(true);
		expect(lastRequest.destroy).toHaveBeenCalled();
	});

	it('rejects invalid JSON', async () => {
		mockResponse(VALID_CARD, { rawBody: '{' });
		await expect(validateA2AAgentCardOrThrow('https://agent.example/card', ['1.0'])).rejects.toThrow(
			'was not valid JSON',
		);
	});

	it('rejects when DNS resolution times out, before opening a connection', async () => {
		jest.useFakeTimers();
		mockResolveWebhookDestinationAllowed.mockImplementation(() => new Promise(() => {}));
		const assertion = expect(validateA2AAgentCardOrThrow('https://agent.example/card', ['1.0'])).rejects.toThrow(
			'timed out',
		);
		await jest.advanceTimersByTimeAsync(AGENT_CARD_FETCH_TIMEOUT_MS);
		await assertion;
		expect(mockRequest).not.toHaveBeenCalled();
	});

	it('rejects when the response body stalls and destroys the connection', async () => {
		jest.useFakeTimers();
		mockRequest.mockImplementation((...args: any[]) => {
			const options = args[1] as RequestOptions;
			const callback = args[2] as (response: IncomingMessage) => void;
			const response = new PassThrough() as unknown as IncomingMessage;
			response.statusCode = 200;
			response.headers = { 'content-type': 'application/json' };
			const req = new EventEmitter() as ClientRequest;
			req.end = jest.fn(() => {
				callback(response);
				return req;
			}) as ClientRequest['end'];
			req.destroy = jest.fn(() => req);
			options.signal?.addEventListener('abort', () => {
				response.destroy(new Error('aborted'));
				req.emit('error', new Error('aborted'));
			});
			lastResponse = response;
			return req;
		});
		const assertion = expect(validateA2AAgentCardOrThrow('https://agent.example/card', ['1.0'])).rejects.toThrow(
			'timed out',
		);
		await jest.advanceTimersByTimeAsync(AGENT_CARD_FETCH_TIMEOUT_MS);
		await assertion;
		expect(lastResponse.destroyed).toBe(true);
	});
});
