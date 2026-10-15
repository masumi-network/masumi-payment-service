/**
 * Cross-service: a forged redemption must not consume an invite.
 *
 * Runs the real Hydra Host control and exchange planes on loopback, and the
 * real payment-service Host client against them. Only the database, the
 * signature check, and head creation are stubbed. Before staging, a forged
 * POST spent the nonce on the Host before the issuer verified it, so the
 * intended redeemer was refused and the cleanup removal was refused too.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const ADMIN = 'a'.repeat(40);
const GENUINE_WALLET = 'addr_test1_genuine';
const MATERIAL = {
	walletAddress: GENUINE_WALLET,
	hydraVerificationKey: `5820${'ab'.repeat(32)}`,
	cardanoVerificationKey: `5820${'cd'.repeat(32)}`,
	advertise: 'hydra2.example.com:5001',
	exchangeUrl: 'https://exchange.hydra2.example.com/exchange',
};
const FORGED = { ...MATERIAL, walletAddress: 'addr_test1_attacker' };
const NONCE = 'nonce-crossservice';

const host = { id: 'host', name: 'host', baseUrl: '', encryptedAdminToken: ADMIN, allowInsecureHttp: true };
const invite = {
	id: 'invite',
	nonce: NONCE,
	hostNodeId: 'node-1',
	hydraHostId: 'host',
	role: 'Issuer',
	status: 'Issued',
	hydraHeadId: null,
	network: 'Preprod',
	localHotWalletId: 'wallet',
	contestationPeriodSeconds: 60,
	LocalHotWallet: { paymentSourceId: 'source' },
	HydraHost: host,
};
const discard = jest.fn(async () => ({ count: 1 }));
const complete = jest.fn(async () => ({}));
const createHead = jest.fn(async (_input: { counterpartyWalletAddress: string }) => ({ hydraHeadId: 'head' }));

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		hydraHost: { findMany: async () => [host] },
		hydraHeadInvite: { findUnique: async () => invite, updateMany: discard, update: complete },
		hydraLocalParticipant: { findFirst: async () => ({ id: 'participant', autoFund: false }), count: async () => 1 },
	},
}));
jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.unstable_mockModule('@/utils/security/encryption', () => ({ decrypt: (value: string) => value }));
// Stands in for the COSE check: only the genuine wallet's signature verifies.
jest.unstable_mockModule('./invite-signing', () => ({
	verifyHydraRedemption: async (input: { redeemerWalletAddress: string }) => {
		if (input.redeemerWalletAddress !== GENUINE_WALLET) throw new Error('signature does not verify');
	},
}));
jest.unstable_mockModule('./orchestrator', () => ({ createHeadFromExchange: createHead }));
jest.unstable_mockModule('./release-reservation', () => ({
	releaseReservedParticipants: jest.fn(),
	canRemoveReservedHostNode: async () => true,
}));
jest.unstable_mockModule('@/services/hydra-node-funding/service', () => ({ fundHydraNodeNow: jest.fn() }));

const { pollHydraRedemptions } = await import('./adoption');
const { loadHostConfig } = await import('@masumi/hydra-host/config');
const { NodeRegistryStore } = await import('@masumi/hydra-host/registry/store');
const { PortAllocator } = await import('@masumi/hydra-host/registry/ports');
const { ExchangeStore } = await import('@masumi/hydra-host/registry/exchange-store');
const { createControlPlane } = await import('@masumi/hydra-host/api/server');
const { createExchangePlane } = await import('@masumi/hydra-host/api/exchange-server');

let dataDir: string;
let exchange: InstanceType<typeof ExchangeStore>;
let controlPlane: Server;
let exchangePlane: Server;
let exchangeBase: string;
const onRedemptionConfirmed = jest.fn(async () => undefined);

async function listen(server: Server): Promise<string> {
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function redeem(material: typeof MATERIAL, signature: string): Promise<number> {
	const response = await fetch(`${exchangeBase}/exchange/redeem`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Connection: 'close' },
		body: JSON.stringify({ nonce: NONCE, redeemer: material, signature: { signature, key: 'key' } }),
	});
	return response.status;
}

beforeEach(async () => {
	jest.clearAllMocks();
	dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hydra-cross-service-'));
	const config = {
		...loadHostConfig({
			get: (key) =>
				({
					HYDRA_HOST_PUBLIC_HOST: 'hydra1.example.com',
					HYDRA_HOST_PUBLIC_EXCHANGE_URL: 'https://exchange.hydra1.example.com/exchange',
					HYDRA_HOST_ADMIN_TOKEN: ADMIN,
					HYDRA_HOST_USER_TOKEN: 'u'.repeat(40),
					HYDRA_HOST_PEER_PORT_COUNT: '4',
				})[key],
		}),
		dataDir,
	};
	const store = new NodeRegistryStore(dataDir);
	const ports = new PortAllocator(config.ports);
	exchange = new ExchangeStore(dataDir);
	const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
	controlPlane = createControlPlane({
		config,
		store,
		exchange,
		ports,
		supervisor: { tick: async () => undefined } as never,
		provision: {
			store,
			ports,
			advertiseFor: (port: number) => `hydra1.example.com:${port}`,
			newNodeId: () => 'node-1',
			now: () => new Date(),
		},
		logger,
		onRedemptionConfirmed,
	});
	exchangePlane = createExchangePlane({ store: exchange, logger });
	host.baseUrl = await listen(controlPlane);
	exchangeBase = await listen(exchangePlane);
	await exchange.registerInvite({
		nonce: NONCE,
		hostNodeId: 'node-1',
		expiresAt: Date.now() + 60_000,
		issuedAt: Date.now(),
		redeemedAt: null,
		redeemer: null,
		redeemerSignature: null,
		staged: [],
		startError: null,
	});
});

afterEach(async () => {
	for (const server of [controlPlane, exchangePlane]) {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
	await fs.rm(dataDir, { recursive: true, force: true });
});

describe('a forged redemption across the Host and the issuer', () => {
	it('is rejected without consuming the invite, and needs no cleanup', async () => {
		expect(await redeem(FORGED, 'forged')).toBe(202);

		expect(await pollHydraRedemptions()).toMatchObject({ rejected: 1, adopted: 0 });

		const [held] = await exchange.listInvites();
		expect(held.redeemedAt).toBeNull();
		expect(held.staged).toEqual([]);
		// Nothing was configured, so there is no node to remove and the invite
		// row was not discarded.
		expect(onRedemptionConfirmed).not.toHaveBeenCalled();
		expect(discard).not.toHaveBeenCalled();
		// The intended redeemer can still use the nonce.
		expect(await redeem(MATERIAL, 'genuine')).toBe(202);
	});

	it('lets the intended redeemer win after a forged candidate', async () => {
		expect(await redeem(FORGED, 'forged')).toBe(202);
		expect(await redeem(MATERIAL, 'genuine')).toBe(202);

		expect(await pollHydraRedemptions()).toMatchObject({ rejected: 1, adopted: 1 });

		expect(onRedemptionConfirmed).toHaveBeenCalledTimes(1);
		expect(createHead).toHaveBeenCalledWith(expect.objectContaining({ counterpartyWalletAddress: GENUINE_WALLET }));
		expect(discard).not.toHaveBeenCalled();
		// Adopted, so the Host was told to forget its copy.
		expect(await exchange.listInvites()).toEqual([]);
	});
});
