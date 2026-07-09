import createHttpError from 'http-errors';
import { Prisma, X402CounterpartyRole, X402EvmWalletType, prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { defineChain, http } from 'viem';

export type HexAddress = `0x${string}`;
export type PrivateKey = `0x${string}`;

export const RPC_REQUEST_TIMEOUT_MS = 30_000;

export function getEip155ChainId(caip2Network: string): number {
	const match = /^eip155:(\d+)$/.exec(caip2Network);
	if (match == null) {
		throw createHttpError(400, 'x402 network must be a CAIP-2 eip155 chain id');
	}
	const chainId = Number(match[1]);
	// Guard against silent precision loss feeding the wrong chain id to viem.
	if (!Number.isSafeInteger(chainId) || chainId <= 0) {
		throw createHttpError(400, 'x402 eip155 chain id is out of range');
	}
	return chainId;
}

export function normalizeAddress(value: string): string {
	return value.toLowerCase();
}

export function assertHexAddress(value: string, label: string): asserts value is HexAddress {
	if (!/^0x[a-fA-F0-9]{40}$/.test(value)) {
		throw createHttpError(400, `${label} must be an EVM address`);
	}
}

export function assertValidPrivateKey(value: string): asserts value is PrivateKey {
	if (!/^0x[a-fA-F0-9]{64}$/.test(value)) {
		throw createHttpError(400, 'x402 wallet private key must be a 0x-prefixed 32-byte hex string');
	}
}

function isPrivateIpv4(ip: string): boolean {
	const parts = ip.split('.').map((part) => Number(part));
	if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
		return true; // malformed → treat as unsafe
	}
	const [a, b] = parts;
	if (a === 0 || a === 127) return true; // this-host / loopback
	if (a === 10) return true; // private
	if (a === 172 && b >= 16 && b <= 31) return true; // private
	if (a === 192 && b === 168) return true; // private
	if (a === 169 && b === 254) return true; // link-local incl. cloud metadata (169.254.169.254)
	if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
	return false;
}

function isPrivateHost(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
	if (host === 'localhost' || host.endsWith('.localhost')) return true;
	if (host.includes(':')) {
		// IPv6: loopback (::1, ::), unique-local (fc00::/7 → fc/fd), link-local (fe80::/10
		// spans fe80–febf, i.e. the fe8/fe9/fea/feb hextet prefixes)
		if (host === '::1' || host === '::') return true;
		if (host.startsWith('fc') || host.startsWith('fd') || /^fe[89ab]/.test(host)) return true;
		const mapped = /::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
		if (mapped != null) return isPrivateIpv4(mapped[1]);
		return false;
	}
	if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return isPrivateIpv4(host);
	return false;
}

// SSRF guard for admin-configured RPC endpoints: reject non-http(s) schemes and hosts
// that are literal private/loopback/link-local addresses (e.g. the cloud metadata IP).
// This checks the hostname/literal IP only and does not resolve DNS, so it is a
// mitigation rather than a complete SSRF defense.
export function assertSafeRpcUrl(rpcUrl: string): void {
	let url: URL;
	try {
		url = new URL(rpcUrl);
	} catch {
		throw createHttpError(400, 'x402 network rpcUrl must be a valid URL');
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw createHttpError(400, 'x402 network rpcUrl must use http or https');
	}
	if (isPrivateHost(url.hostname)) {
		throw createHttpError(400, 'x402 network rpcUrl must not target a private, loopback or link-local address');
	}
}

// Build a viem HTTP transport with an SSRF check and a request timeout, so a slow or
// hostile admin-configured RPC cannot hang a request indefinitely.
export function safeHttpTransport(rpcUrl: string) {
	assertSafeRpcUrl(rpcUrl);
	return http(rpcUrl, { timeout: RPC_REQUEST_TIMEOUT_MS });
}

// EVM native currencies are all 18 decimals, but the symbol differs per chain.
// Hardcoding 'ETH' mislabels the native balance on non-Ethereum EVM networks
// (Polygon POL, Avalanche AVAX, Gnosis xDAI, BNB, ...). Keyed by eip155 chain id;
// unknown chains fall back to ETH.
const NATIVE_CURRENCY_BY_CHAIN_ID: Record<number, { name: string; symbol: string; decimals: number }> = {
	1: { name: 'Ether', symbol: 'ETH', decimals: 18 },
	10: { name: 'Ether', symbol: 'ETH', decimals: 18 },
	56: { name: 'BNB', symbol: 'BNB', decimals: 18 },
	100: { name: 'xDAI', symbol: 'xDAI', decimals: 18 },
	137: { name: 'POL', symbol: 'POL', decimals: 18 },
	8453: { name: 'Ether', symbol: 'ETH', decimals: 18 },
	42161: { name: 'Ether', symbol: 'ETH', decimals: 18 },
	43114: { name: 'Avalanche', symbol: 'AVAX', decimals: 18 },
	84532: { name: 'Ether', symbol: 'ETH', decimals: 18 },
	11155111: { name: 'Ether', symbol: 'ETH', decimals: 18 },
};

export function nativeCurrencyForCaip2(caip2Network: string): { name: string; symbol: string; decimals: number } {
	const chainId = getEip155ChainId(caip2Network);
	return NATIVE_CURRENCY_BY_CHAIN_ID[chainId] ?? { name: 'Ether', symbol: 'ETH', decimals: 18 };
}

export function createChain(caip2Network: string, rpcUrl: string, displayName: string) {
	const chainId = getEip155ChainId(caip2Network);

	return defineChain({
		id: chainId,
		name: displayName,
		nativeCurrency: nativeCurrencyForCaip2(caip2Network),
		rpcUrls: {
			default: { http: [rpcUrl] },
		},
	});
}

// Defense-in-depth: an X402Network row pairs a declared CAIP-2 id with an RPC URL, but
// nothing guarantees the RPC actually serves that chain. Signing/settling against a
// mismatched RPC would build EIP-712 domains and broadcast on the wrong chain, so we
// verify the live chain id before trusting the configured network for fund movement.
export async function assertRpcServesDeclaredChain(
	client: { getChainId: () => Promise<number> },
	caip2Network: string,
) {
	const expectedChainId = getEip155ChainId(caip2Network);
	let actualChainId: number;
	try {
		actualChainId = await client.getChainId();
	} catch (error) {
		logger.error('x402 network RPC is unreachable while verifying its chain id', { caip2Network, error });
		throw createHttpError(502, 'x402 network RPC is unreachable');
	}
	if (actualChainId !== expectedChainId) {
		logger.error('x402 network RPC serves a different chain than its configured CAIP-2 id', {
			caip2Network,
			expectedChainId,
			actualChainId,
		});
		throw createHttpError(
			502,
			`x402 network RPC serves chain id ${actualChainId} but ${caip2Network} expects ${expectedChainId}`,
		);
	}
}

export async function getX402NetworkOrThrow(caip2Network: string) {
	const network = await prisma.x402Network.findUnique({
		where: { caip2Id: caip2Network },
		include: {
			// The facilitator's Secret is needed to build a local settlement signer; loading it
			// here keeps getFacilitatorForNetwork to a single query. Remote-facilitator networks
			// have no FacilitatorWallet and rely on facilitatorUrl instead.
			FacilitatorWallet: { include: { Secret: true } },
		},
	});
	if (network == null || !network.isEnabled) {
		throw createHttpError(404, 'x402 network is not enabled');
	}
	return network;
}

function assertWalletType(wallet: { type: X402EvmWalletType }, expectedType?: X402EvmWalletType) {
	// Enforce the direction split: a Purchasing wallet may only fund outbound payments
	// and a Selling wallet may only settle inbound ones, so reject a wallet used for the
	// wrong side rather than letting it sign on a side it was not provisioned for.
	if (expectedType != null && wallet.type !== expectedType) {
		throw createHttpError(
			400,
			expectedType === X402EvmWalletType.Purchasing
				? 'Managed EVM wallet is not a Purchasing wallet'
				: 'Managed EVM wallet is not a Selling wallet',
		);
	}
}

export async function getManagedWalletOrThrow(evmWalletId: string, expectedType?: X402EvmWalletType) {
	const wallet = await prisma.x402EvmWallet.findUnique({
		where: { id: evmWalletId, deletedAt: null },
	});
	if (wallet == null) {
		throw createHttpError(404, 'Managed EVM wallet not found');
	}
	assertWalletType(wallet, expectedType);
	return wallet;
}

// Load a managed wallet together with its encrypted key (Secret) and bound Network, for the
// signing/settling paths that must decrypt the key and pin the chain. Kept separate from
// getManagedWalletOrThrow so validation-only callers never over-fetch the secret material.
export async function getManagedWalletWithSecretOrThrow(evmWalletId: string, expectedType?: X402EvmWalletType) {
	const wallet = await prisma.x402EvmWallet.findUnique({
		where: { id: evmWalletId, deletedAt: null },
		include: { Secret: true, Network: true },
	});
	if (wallet == null) {
		throw createHttpError(404, 'Managed EVM wallet not found');
	}
	assertWalletType(wallet, expectedType);
	return wallet;
}

// Resolve (idempotently) the counterparty entity for an attempt and return its id. The
// address is normalized so the same on-chain party dedupes to one row per (chain, role).
// Returns null for a missing/empty address (e.g. an inbound payer not yet reported).
export async function upsertCounterpartyWalletId(
	client: Prisma.TransactionClient | typeof prisma,
	input: { caip2Network: string; address: string | null | undefined; role: X402CounterpartyRole },
): Promise<string | null> {
	if (input.address == null || input.address === '') return null;
	const address = normalizeAddress(input.address);
	// Prisma's `upsert` compiles to find-then-create under the pg driver adapter (not a native
	// ON CONFLICT), so two concurrent first-inserts of the same counterparty lose the unique race
	// with P2002 — which, when this runs inside a transaction (the outbound reserve path), aborts
	// the whole tx and fails the payment. Use a native ON CONFLICT DO NOTHING so concurrent callers
	// converge on one row with no error, then read the id back (it is guaranteed to exist).
	await client.$executeRaw`
		INSERT INTO "X402CounterpartyWallet" ("id", "updatedAt", "caip2Network", "address", "role")
		VALUES (gen_random_uuid()::text, now(), ${input.caip2Network}, ${address}, ${input.role}::"X402CounterpartyRole")
		ON CONFLICT ("caip2Network", "address", "role") DO NOTHING
	`;
	const counterparty = await client.x402CounterpartyWallet.findUniqueOrThrow({
		where: {
			caip2Network_address_role: { caip2Network: input.caip2Network, address, role: input.role },
		},
		select: { id: true },
	});
	return counterparty.id;
}
