import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

const mockAssertWebhookDestinationAllowed = jest.fn() as jest.Mock<any>;

class TestWebhookDestinationPolicyError extends Error {
	constructor(public readonly reason: string) {
		super(reason);
		this.name = 'WebhookDestinationPolicyError';
	}
}

jest.unstable_mockModule('@/utils/security/webhook-destination-policy', () => ({
	assertWebhookDestinationAllowed: mockAssertWebhookDestinationAllowed,
	isWebhookDestinationPolicyError: jest.fn((error: unknown) => error instanceof TestWebhookDestinationPolicyError),
}));

const { agentCardSchema, validateA2AAgentCardOrThrow, AGENT_CARD_FETCH_TIMEOUT_MS, AGENT_CARD_MAX_BYTES } =
	await import('./agent-card');

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

function mockFetchResponse(
	body: unknown,
	init?: { ok?: boolean; status?: number; contentType?: string; contentLength?: string },
): Response {
	const text = JSON.stringify(body);
	return {
		ok: init?.ok ?? true,
		status: init?.status ?? 200,
		headers: {
			get: (name: string) => {
				if (name === 'content-type') return init?.contentType ?? 'application/json';
				if (name === 'content-length') return init?.contentLength ?? null;
				return null;
			},
		},
		text: async () => text,
	} as unknown as Response;
}

describe('agentCardSchema', () => {
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
		mockAssertWebhookDestinationAllowed.mockImplementation(async (url: string) => new URL(url));
		global.fetch = jest.fn(async () => mockFetchResponse(VALID_CARD)) as unknown as typeof fetch;
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
		expect(mockAssertWebhookDestinationAllowed).not.toHaveBeenCalled();
	});

	it('rejects when the SSRF guard blocks the destination', async () => {
		mockAssertWebhookDestinationAllowed.mockRejectedValue(
			new TestWebhookDestinationPolicyError('resolved to a blocked address'),
		);
		await expect(validateA2AAgentCardOrThrow('https://blocked.example/agent-card.json', ['1.0'])).rejects.toThrow(
			'A2A agent card URL rejected',
		);
	});

	it('rejects a non-JSON content-type', async () => {
		global.fetch = jest.fn(async () =>
			mockFetchResponse(VALID_CARD, { contentType: 'text/html' }),
		) as unknown as typeof fetch;
		await expect(
			validateA2AAgentCardOrThrow('https://agent.example/.well-known/agent-card.json', ['1.0']),
		).rejects.toThrow('was not application/json');
	});

	it('rejects a non-2xx fetch status', async () => {
		global.fetch = jest.fn(async () =>
			mockFetchResponse(VALID_CARD, { ok: false, status: 404 }),
		) as unknown as typeof fetch;
		await expect(
			validateA2AAgentCardOrThrow('https://agent.example/.well-known/agent-card.json', ['1.0']),
		).rejects.toThrow('status 404');
	});

	it('rejects a raw network failure as a 400, not an unhandled 500', async () => {
		global.fetch = jest.fn(async () => {
			throw new TypeError('fetch failed: ECONNREFUSED');
		}) as unknown as typeof fetch;
		await expect(
			validateA2AAgentCardOrThrow('https://agent.example/.well-known/agent-card.json', ['1.0']),
		).rejects.toMatchObject({ status: 400, message: expect.stringContaining('Could not fetch A2A agent card') });
	});

	it('rejects a response exceeding the size cap (content-length)', async () => {
		global.fetch = jest.fn(async () =>
			mockFetchResponse(VALID_CARD, { contentLength: String(AGENT_CARD_MAX_BYTES + 1) }),
		) as unknown as typeof fetch;
		await expect(
			validateA2AAgentCardOrThrow('https://agent.example/.well-known/agent-card.json', ['1.0']),
		).rejects.toThrow('exceeds the maximum allowed size');
	});

	it('rejects a schema-invalid card', async () => {
		global.fetch = jest.fn(async () => mockFetchResponse({ name: 'x' })) as unknown as typeof fetch;
		await expect(
			validateA2AAgentCardOrThrow('https://agent.example/.well-known/agent-card.json', ['1.0']),
		).rejects.toThrow('A2A agent card is invalid');
	});

	it('rejects when a declared protocol version is absent from the fetched card', async () => {
		await expect(
			validateA2AAgentCardOrThrow('https://agent.example/.well-known/agent-card.json', ['9.9']),
		).rejects.toThrow('does not support declared protocol version');
	});

	it('rejects when the fetch times out', async () => {
		jest.useFakeTimers();
		global.fetch = jest.fn((_url: unknown, init?: RequestInit) => {
			return new Promise((_resolve, reject) => {
				init?.signal?.addEventListener('abort', () => {
					reject(new DOMException('The operation was aborted.', 'AbortError'));
				});
			});
		}) as unknown as typeof fetch;

		const resultPromise = validateA2AAgentCardOrThrow('https://agent.example/.well-known/agent-card.json', ['1.0']);
		// Let the fetch call register its abort listener before advancing timers.
		await Promise.resolve();
		await Promise.resolve();
		jest.advanceTimersByTime(AGENT_CARD_FETCH_TIMEOUT_MS);
		await expect(resultPromise).rejects.toThrow('timed out');
	});
});
