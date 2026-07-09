import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { createPublicClient } from 'viem';
import {
	assertRpcServesDeclaredChain,
	createChain,
	type HexAddress,
	nativeCurrencyForCaip2,
	normalizeAddress,
	safeHttpTransport,
} from './internal';
import type { X402OwnerScope } from './internal';
import { getX402ManagedWallet } from './wallets';

// Minimal ERC-20 read surface — balance plus display metadata.
const ERC20_ABI = [
	{
		type: 'function',
		name: 'balanceOf',
		stateMutability: 'view',
		inputs: [{ name: 'account', type: 'address' }],
		outputs: [{ type: 'uint256' }],
	},
	{ type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
	{ type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
] as const;

export type X402TokenBalance = {
	asset: string;
	symbol: string | null;
	decimals: number;
	amount: string;
};

export type X402NetworkBalance = {
	caip2Network: string;
	displayName: string;
	native: { symbol: string; decimals: number; amount: string } | null;
	asset: X402TokenBalance | null;
	error: string | null;
};

export function buildPublicClient(network: { caip2Id: string; rpcUrl: string; displayName: string }) {
	const chain = createChain(network.caip2Id, network.rpcUrl, network.displayName);
	return createPublicClient({ chain, transport: safeHttpTransport(network.rpcUrl) });
}

// The literal asset id used by a low-balance rule to mean the chain's native gas token
// (rather than an ERC-20 contract).
export const NATIVE_ASSET = 'native';

// Reads the raw balance (base units) of `asset` for `owner` on an already-built client.
// `asset` is "native" for the gas token, otherwise an ERC-20 contract address.
export async function readAssetAmount(
	client: ReturnType<typeof buildPublicClient>,
	owner: HexAddress,
	asset: string,
): Promise<bigint> {
	if (asset === NATIVE_ASSET) {
		return client.getBalance({ address: owner });
	}
	const amount = await client.readContract({
		address: asset as HexAddress,
		abi: ERC20_ABI,
		functionName: 'balanceOf',
		args: [owner],
	});
	return amount;
}

async function readErc20Balance(
	client: ReturnType<typeof buildPublicClient>,
	asset: HexAddress,
	owner: HexAddress,
): Promise<X402TokenBalance> {
	// decimals/symbol can revert on non-compliant tokens, so default them rather than
	// failing the whole balance read.
	const [amount, decimals, symbol] = await Promise.all([
		client.readContract({ address: asset, abi: ERC20_ABI, functionName: 'balanceOf', args: [owner] }),
		client.readContract({ address: asset, abi: ERC20_ABI, functionName: 'decimals' }).catch(() => 18),
		client.readContract({ address: asset, abi: ERC20_ABI, functionName: 'symbol' }).catch(() => null),
	]);
	return {
		asset: normalizeAddress(asset),
		symbol: symbol == null ? null : String(symbol),
		decimals: Number(decimals),
		amount: amount.toString(),
	};
}

/**
 * Reads the on-chain balances of a managed wallet across the enabled x402 networks (or a
 * single network when `caip2Network` is given). For each network it returns the native gas
 * balance and the network's default token balance. RPC failures are captured per network so
 * one unreachable chain does not blank out the rest.
 */
export async function getX402WalletBalances(input: {
	evmWalletId: string;
	caip2Network?: string;
	ownerScope?: X402OwnerScope;
}): Promise<{ evmWalletId: string; address: string; Balances: X402NetworkBalance[] }> {
	const wallet = await getX402ManagedWallet(input.evmWalletId, input.ownerScope ?? null);
	const owner = wallet.address as HexAddress;

	// A managed wallet is bound to exactly one payment source, so its balance is read on that
	// network only. The optional caip2Network arg can further pin it (returns empty if it does
	// not match the wallet's own network).
	const networks = await prisma.x402Network.findMany({
		where: { isEnabled: true, id: wallet.networkId, caip2Id: input.caip2Network },
		orderBy: { caip2Id: 'asc' },
		select: { caip2Id: true, rpcUrl: true, displayName: true, defaultAsset: true },
	});

	const balances = await Promise.all(
		networks.map(async (network): Promise<X402NetworkBalance> => {
			try {
				const client = buildPublicClient(network);
				await assertRpcServesDeclaredChain(client, network.caip2Id);
				const [nativeAmount, assetBalance] = await Promise.all([
					client.getBalance({ address: owner }),
					network.defaultAsset
						? readErc20Balance(client, network.defaultAsset as HexAddress, owner)
						: Promise.resolve(null),
				]);
				const nativeCurrency = nativeCurrencyForCaip2(network.caip2Id);
				return {
					caip2Network: network.caip2Id,
					displayName: network.displayName,
					native: {
						symbol: nativeCurrency.symbol,
						decimals: nativeCurrency.decimals,
						amount: nativeAmount.toString(),
					},
					asset: assetBalance,
					error: null,
				};
			} catch (error) {
				logger.warn('x402 wallet balance lookup failed for a network', {
					evmWalletId: input.evmWalletId,
					caip2Network: network.caip2Id,
					error,
				});
				return {
					caip2Network: network.caip2Id,
					displayName: network.displayName,
					native: null,
					asset: null,
					error: 'Balance unavailable: the network RPC could not be reached',
				};
			}
		}),
	);

	return { evmWalletId: wallet.id, address: wallet.address, Balances: balances };
}
