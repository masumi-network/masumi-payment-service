/**
 * A signed invite proves who chose its periods, not that they are safe.
 *
 * The issuer runs its own service, which may never have checked them. A
 * redemption used to judge only mainnet's contestation floor, so an invite
 * whose out-of-sync limit exceeded half its dispute window, or whose deposit
 * period sat outside the route's bounds, reserved a node, keys and a peer port
 * before anything noticed. Every case below is signed by a real wallet so the
 * refusal can only come from the periods.
 */

import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { MeshWallet } from '@meshsdk/core';
import { Network, PaymentSourceType, HotWalletType } from '@/generated/prisma/client';
import type { Mock } from 'jest-mock';
import type { HydraHeadInvitePayloadInput } from './invite-payload';

type AnyMock = Mock<(...args: any[]) => any>;

const REACHED_RESERVATION = 'reached node reservation';
const LEDGER_PARAMS_HASH = 'sha256:params';

const mockHotWalletFindFirst = jest.fn() as AnyMock;
const mockInviteFindUnique = jest.fn() as AnyMock;
const mockHeadFindFirst = jest.fn() as AnyMock;
const mockHostFindMany = jest.fn() as AnyMock;
const mockProvision = jest.fn() as AnyMock;

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		hotWallet: { findFirst: mockHotWalletFindFirst },
		hydraHeadInvite: { findUnique: mockInviteFindUnique, create: jest.fn() },
		hydraHead: { findFirst: mockHeadFindFirst },
		hydraHost: { findMany: mockHostFindMany },
		hydraLocalParticipant: { findFirst: jest.fn(), create: jest.fn() },
	},
}));

// Identity, so a plain mnemonic can stand in for an encrypted one.
jest.unstable_mockModule('@/utils/security/encryption', () => ({
	encrypt: (value: string) => value,
	decrypt: (value: string) => value,
}));

jest.unstable_mockModule('@/services/hydra-host/client', () => ({
	HydraHostRequestError: class extends Error {},
	acknowledgeEscrowOnHost: jest.fn(),
	fetchHostCapabilities: jest.fn(),
	hostNodeUrls: jest.fn(),
	provisionNodeOnHost: mockProvision,
	registerInviteOnHost: jest.fn(),
	setHostNodePeers: jest.fn(),
	startHostNode: jest.fn(),
}));

jest.unstable_mockModule('@/services/hydra-host/compatibility', () => ({
	expectedHostCapabilitiesForNetwork: () => ({ ledgerParamsHash: LEDGER_PARAMS_HASH }),
}));

jest.unstable_mockModule('./exchange-client', () => ({
	assertExchangeTransportAllowed: () => undefined,
	resolveExchangeTarget: async () => undefined,
	postRedemption: jest.fn(),
}));

jest.unstable_mockModule('@/services/hydra-node-funding/service', () => ({
	fundHydraNodeNow: jest.fn(),
}));

jest.unstable_mockModule('@/routes/api/hydra/head/create-head', () => ({
	createBoundHydraHead: jest.fn(),
}));

let mintHeadInvite: typeof import('./orchestrator').mintHeadInvite;
let redeemHeadInvite: typeof import('./orchestrator').redeemHeadInvite;
let signHydraHeadInvite: typeof import('./invite-signing').signHydraHeadInvite;
let generateOfflineWallet: typeof import('@/utils/generator/wallet-generator').generateOfflineWallet;

type TestWallet = { mnemonic: string; address: string };
const wallets: Partial<Record<Network, { issuer: TestWallet; redeemer: TestWallet }>> = {};

async function brewWallet(network: Network): Promise<TestWallet> {
	const brewed = MeshWallet.brew(false);
	const words = typeof brewed === 'string' ? brewed.split(' ') : brewed;
	const address = (await generateOfflineWallet(network, words).getUnusedAddresses())[0];
	return { mnemonic: words.join(' '), address };
}

function walletRow(network: Network, wallet: TestWallet, type: HotWalletType) {
	return {
		id: `wallet-${type}`,
		paymentSourceId: 'source-1',
		walletAddress: wallet.address,
		type,
		Secret: { encryptedMnemonic: wallet.mnemonic },
		PaymentSource: { network, paymentSourceType: PaymentSourceType.Web3CardanoV2 },
	};
}

const VALID_PERIODS = {
	contestationPeriodSeconds: 43_200,
	depositPeriodSeconds: 600,
	unsyncedPeriodSeconds: 1800,
};

async function signedInvite(network: Network, periods: Partial<typeof VALID_PERIODS>) {
	const { issuer } = wallets[network]!;
	const payload: HydraHeadInvitePayloadInput = {
		nonce: `nonce-${Math.random()}`,
		expiresAt: String(Date.now() + 3_600_000),
		network,
		issuerWalletAddress: issuer.address,
		issuerWalletRole: 'Seller',
		hydraVerificationKey: '5820aa',
		cardanoVerificationKey: '5820bb',
		advertise: 'issuer.example.com:5001',
		exchangeUrl: 'https://issuer.example.com/exchange',
		...VALID_PERIODS,
		...periods,
		ledgerParamsHash: LEDGER_PARAMS_HASH,
	};
	const signature = await signHydraHeadInvite(payload, {
		encryptedMnemonic: issuer.mnemonic,
		walletAddress: issuer.address,
		network,
	});
	return { payload, signature };
}

async function redeem(network: Network, periods: Partial<typeof VALID_PERIODS>) {
	mockHotWalletFindFirst.mockResolvedValue(walletRow(network, wallets[network]!.redeemer, HotWalletType.Purchasing));
	return redeemHeadInvite({ invite: await signedInvite(network, periods), localHotWalletId: 'wallet-Purchasing' });
}

beforeAll(async () => {
	({ mintHeadInvite, redeemHeadInvite } = await import('./orchestrator'));
	({ signHydraHeadInvite } = await import('./invite-signing'));
	({ generateOfflineWallet } = await import('@/utils/generator/wallet-generator'));
	for (const network of [Network.Preprod, Network.Mainnet]) {
		wallets[network] = { issuer: await brewWallet(network), redeemer: await brewWallet(network) };
	}
});

beforeEach(() => {
	jest.clearAllMocks();
	mockInviteFindUnique.mockResolvedValue(null);
	mockHeadFindFirst.mockResolvedValue(null);
	// The first thing a reservation does. Reaching it means every period check passed.
	mockHostFindMany.mockRejectedValue(new Error(REACHED_RESERVATION));
});

const INVALID_PERIODS: Array<[string, Network, Partial<typeof VALID_PERIODS>, RegExp]> = [
	['a deposit period under the route minimum', Network.Preprod, { depositPeriodSeconds: 299 }, /depositPeriodSeconds/],
	[
		'a deposit period over the route maximum',
		Network.Preprod,
		{ depositPeriodSeconds: 86_401 },
		/depositPeriodSeconds/,
	],
	['a fractional deposit period', Network.Preprod, { depositPeriodSeconds: 600.5 }, /depositPeriodSeconds/],
	[
		'a contestation period under the route minimum',
		Network.Preprod,
		{ contestationPeriodSeconds: 299, unsyncedPeriodSeconds: 120 },
		/contestationPeriodSeconds/,
	],
	[
		'a contestation period over the route maximum',
		Network.Preprod,
		{ contestationPeriodSeconds: 1_209_601 },
		/contestationPeriodSeconds/,
	],
	[
		'a contestation period under the mainnet floor',
		Network.Mainnet,
		{ contestationPeriodSeconds: 3600 },
		/Mainnet Hydra heads require/,
	],
	[
		'an out-of-sync limit over half the dispute window',
		Network.Preprod,
		{ contestationPeriodSeconds: 600, unsyncedPeriodSeconds: 301 },
		/cannot exceed half the dispute window/,
	],
	['an out-of-sync limit under the floor', Network.Preprod, { unsyncedPeriodSeconds: 119 }, /below the 120s floor/],
	['a fractional out-of-sync limit', Network.Preprod, { unsyncedPeriodSeconds: 1800.5 }, /unsyncedPeriodSeconds/],
];

describe('redeeming a correctly signed invite', () => {
	// The control: without it, every refusal below could come from the
	// signature, the wallet or the mocks rather than from the periods.
	it.each([Network.Preprod, Network.Mainnet])('with valid periods on %s reaches node reservation', async (network) => {
		await expect(redeem(network, {})).rejects.toThrow(REACHED_RESERVATION);
		expect(mockHostFindMany).toHaveBeenCalledTimes(1);
	});

	it.each(INVALID_PERIODS)('with %s is refused before provisioning', async (_name, network, periods, message) => {
		await expect(redeem(network, periods)).rejects.toMatchObject({
			status: 400,
			message: expect.stringMatching(message),
		});
		expect(mockHostFindMany).not.toHaveBeenCalled();
		expect(mockProvision).not.toHaveBeenCalled();
	});
});

describe('minting an invite', () => {
	async function mint(network: Network, periods: Partial<typeof VALID_PERIODS>) {
		mockHotWalletFindFirst.mockResolvedValue(walletRow(network, wallets[network]!.issuer, HotWalletType.Selling));
		return mintHeadInvite({ localHotWalletId: 'wallet-Selling', ...VALID_PERIODS, ...periods });
	}

	it('with valid periods reaches node reservation', async () => {
		await expect(mint(Network.Preprod, {})).rejects.toThrow(REACHED_RESERVATION);
	});

	it.each(INVALID_PERIODS)('with %s is refused before provisioning', async (_name, network, periods, message) => {
		await expect(mint(network, periods)).rejects.toMatchObject({
			status: 400,
			message: expect.stringMatching(message),
		});
		expect(mockHostFindMany).not.toHaveBeenCalled();
		expect(mockProvision).not.toHaveBeenCalled();
	});
});
