import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { HostInviteRecord } from './client';
import { HydraProtocolError } from '@/lib/hydra/hydra/errors';
import { encrypt } from '@/utils/security/encryption';

const findHosts = jest.fn<() => Promise<object[]>>();
const findInvite = jest.fn<(query: { where: { nonce: string } }) => Promise<null>>();
jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		hydraHost: { findMany: findHosts },
		hydraHeadInvite: { findUnique: findInvite },
	},
}));

let fetchHostRedemptions: typeof import('./client').fetchHostRedemptions;
let pollHydraRedemptions: typeof import('../hydra-invite/adoption').pollHydraRedemptions;
let server: Server;
let baseUrl: string;
let responseBody: string;
const requests: string[] = [];
const transport = { allowInsecureHttp: true };
const originalTrustedHosts = process.env.HYDRA_TRUSTED_PRIVATE_HOSTS;
const NOW = 1_790_000_000_000;
const record: HostInviteRecord = {
	nonce: 'nonce-redemption',
	hostNodeId: 'node-1',
	expiresAt: NOW + 60_000,
	redeemedAt: NOW - 1_000,
	redeemer: {
		walletAddress: 'addr_test1qexample',
		hydraVerificationKey: `5820${'11'.repeat(32)}`,
		cardanoVerificationKey: `5820${'22'.repeat(32)}`,
		advertise: 'peer.example.com:5001',
		exchangeUrl: 'https://peer.example.com/exchange',
	},
	redeemerSignature: { signature: 'signed-payload', key: 'signer-key' },
	startError: null,
};
const validResponse = { invites: [record], now: NOW };

beforeAll(async () => {
	({ fetchHostRedemptions } = await import('./client'));
	({ pollHydraRedemptions } = await import('../hydra-invite/adoption'));
	server = createServer((request, response) => {
		requests.push(request.url ?? '');
		response.writeHead(200, { 'Content-Type': 'application/json' });
		response.end(request.url?.startsWith('/healthy/') ? JSON.stringify(validResponse) : responseBody);
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
	requests.length = 0;
	jest.clearAllMocks();
	if (originalTrustedHosts === undefined) delete process.env.HYDRA_TRUSTED_PRIVATE_HOSTS;
	else process.env.HYDRA_TRUSTED_PRIVATE_HOSTS = originalTrustedHosts;
});

afterAll(async () => {
	server?.closeAllConnections();
	await new Promise<void>((resolve) => server?.close(() => resolve()));
});

async function fetchBody(body: unknown) {
	process.env.HYDRA_TRUSTED_PRIVATE_HOSTS = '127.0.0.1';
	responseBody = JSON.stringify(body);
	return await fetchHostRedemptions(baseUrl, 'admin-token', 0, transport);
}

describe('Host redemption response validation over HTTP', () => {
	it.each([
		['a non-object response', null],
		['a missing invite list', { now: NOW }],
		['a non-array invite list', { invites: {}, now: NOW }],
		['a null entry', { invites: [null], now: NOW }],
		['a malformed entry after a valid record', { invites: [record, null], now: NOW }],
		['an array entry', { invites: [[]], now: NOW }],
		['a missing nonce', { invites: [{ ...record, nonce: undefined }], now: NOW }],
		['an oversized nonce', { invites: [{ ...record, nonce: 'a'.repeat(65) }], now: NOW }],
		['a missing node id', { invites: [{ ...record, hostNodeId: undefined }], now: NOW }],
		['a string expiry', { invites: [{ ...record, expiresAt: String(NOW) }], now: NOW }],
		['an out-of-range expiry', { invites: [{ ...record, expiresAt: 1e16 }], now: NOW }],
		['a nonnumeric redemption time', { invites: [{ ...record, redeemedAt: {} }], now: NOW }],
		['a primitive redeemer', { invites: [{ ...record, redeemer: 'wallet' }], now: NOW }],
		['an array redeemer', { invites: [{ ...record, redeemer: [] }], now: NOW }],
		['a missing redeemer field', { invites: [{ ...record, redeemer: {} }], now: NOW }],
		[
			'a null wallet address',
			{ invites: [{ ...record, redeemer: { ...record.redeemer, walletAddress: null } }], now: NOW },
		],
		[
			'an oversized exchange URL',
			{ invites: [{ ...record, redeemer: { ...record.redeemer, exchangeUrl: 'x'.repeat(2049) } }], now: NOW },
		],
		['a primitive signature', { invites: [{ ...record, redeemerSignature: 'signature' }], now: NOW }],
		['an array signature', { invites: [{ ...record, redeemerSignature: [] }], now: NOW }],
		['a missing signer key', { invites: [{ ...record, redeemerSignature: { signature: 'signature' } }], now: NOW }],
		[
			'a null signature field',
			{ invites: [{ ...record, redeemerSignature: { signature: null, key: 'key' } }], now: NOW },
		],
		[
			'an oversized signature',
			{ invites: [{ ...record, redeemerSignature: { signature: 'x'.repeat(4097), key: 'key' } }], now: NOW },
		],
		['a non-string start error', { invites: [{ ...record, startError: {} }], now: NOW }],
		['a missing watermark', { invites: [record] }],
		['a string watermark', { invites: [record], now: String(NOW) }],
		['an out-of-range watermark', { invites: [record], now: 1e16 }],
	])('rejects %s before it reaches adoption', async (_scenario, body) => {
		await expect(fetchBody(body)).rejects.toBeInstanceOf(HydraProtocolError);
	});

	it.each(['now', 'expiresAt', 'redeemedAt'])(
		'rejects a non-finite %s encoded as JSON exponent overflow',
		async (field) => {
			process.env.HYDRA_TRUSTED_PRIVATE_HOSTS = '127.0.0.1';
			responseBody = JSON.stringify(validResponse).replace(new RegExp(`"${field}":\\d+`), `"${field}":1e309`);
			await expect(fetchHostRedemptions(baseUrl, 'admin-token', 0, transport)).rejects.toBeInstanceOf(
				HydraProtocolError,
			);
		},
	);

	it('accepts redeemed and unredeemed records and additive Host fields', async () => {
		const unredeemed = {
			...record,
			nonce: 'nonce-unredeemed',
			redeemedAt: null,
			redeemer: null,
			redeemerSignature: null,
		};
		await expect(
			fetchBody({ invites: [{ ...record, issuedAt: NOW - 10_000 }, unredeemed], now: NOW, extra: true }),
		).resolves.toEqual({
			invites: [record, unredeemed],
			now: NOW,
		});
	});

	it('accepts an empty redemption list', async () => {
		await expect(fetchBody({ invites: [], now: NOW })).resolves.toEqual({ invites: [], now: NOW });
	});

	it('continues polling the next Host after a malformed response', async () => {
		process.env.HYDRA_TRUSTED_PRIVATE_HOSTS = '127.0.0.1';
		responseBody = JSON.stringify({ invites: [null], now: NOW });
		const encryptedAdminToken = encrypt('admin-token');
		findHosts.mockResolvedValue([
			{ id: 'malformed-host', name: 'Malformed', baseUrl, encryptedAdminToken, ...transport, pausedAt: null },
			{
				id: 'healthy-host',
				name: 'Healthy',
				baseUrl: `${baseUrl}/healthy`,
				encryptedAdminToken,
				...transport,
				pausedAt: null,
			},
		]);
		findInvite.mockResolvedValue(null);

		await expect(pollHydraRedemptions()).resolves.toEqual({ polled: 1, adopted: 0, rejected: 0 });
		expect(requests).toEqual(['/v1/invites?redeemedSince=0', '/healthy/v1/invites?redeemedSince=0']);
		expect(findInvite).toHaveBeenCalledWith(expect.objectContaining({ where: { nonce: record.nonce } }));

		requests.length = 0;
		responseBody = JSON.stringify({ invites: [], now: NOW });
		await expect(pollHydraRedemptions()).resolves.toEqual({ polled: 2, adopted: 0, rejected: 0 });
		expect(requests).toEqual(['/v1/invites?redeemedSince=0', `/healthy/v1/invites?redeemedSince=${NOW}`]);
	});
});
