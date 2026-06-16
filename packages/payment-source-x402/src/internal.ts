import createHttpError from 'http-errors';
import { X402EvmWalletType, prisma } from '@masumi/payment-core/db';
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

export function createChain(caip2Network: string, rpcUrl: string, displayName: string) {
	const chainId = getEip155ChainId(caip2Network);

	return defineChain({
		id: chainId,
		name: displayName,
		nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
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
			FacilitatorWallet: true,
		},
	});
	if (network == null || !network.isEnabled) {
		throw createHttpError(404, 'x402 network is not enabled');
	}
	return network;
}

export async function getManagedWalletOrThrow(evmWalletId: string, expectedType?: X402EvmWalletType) {
	const wallet = await prisma.x402EvmWallet.findUnique({
		where: { id: evmWalletId, deletedAt: null },
	});
	if (wallet == null) {
		throw createHttpError(404, 'Managed EVM wallet not found');
	}
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
	return wallet;
}
