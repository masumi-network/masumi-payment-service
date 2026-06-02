import type { Network } from '@prisma/client';

export const CARDANO_MAINNET_CAIP2 = 'cardano:mainnet';
export const CARDANO_PREPROD_CAIP2 = 'cardano:preprod';
export const BASE_MAINNET_CAIP2 = 'eip155:8453';
export const BASE_SEPOLIA_CAIP2 = 'eip155:84532';

export const DEFAULT_ADMIN_CAIP2_NETWORK_LIMIT = [
	CARDANO_MAINNET_CAIP2,
	CARDANO_PREPROD_CAIP2,
	BASE_MAINNET_CAIP2,
	BASE_SEPOLIA_CAIP2,
] as const;

export function cardanoNetworkToCaip2(network: Network): string {
	switch (network) {
		case 'Mainnet':
			return CARDANO_MAINNET_CAIP2;
		case 'Preprod':
			return CARDANO_PREPROD_CAIP2;
		default:
			throw new Error('Invalid network');
	}
}

export function caip2ToCardanoNetwork(chainId: string): Network | null {
	switch (chainId) {
		case CARDANO_MAINNET_CAIP2:
		case 'Mainnet':
			return 'Mainnet';
		case CARDANO_PREPROD_CAIP2:
		case 'Preprod':
			return 'Preprod';
		default:
			return null;
	}
}

export function cardanoNetworksToCaip2(networks: Network[]): string[] {
	return Array.from(new Set(networks.map(cardanoNetworkToCaip2)));
}

export function caip2LimitToCardanoNetworks(chainIds: string[]): Network[] {
	const result: Network[] = [];
	for (const chainId of chainIds) {
		const network = caip2ToCardanoNetwork(chainId);
		if (network != null && !result.includes(network)) {
			result.push(network);
		}
	}
	return result;
}

export function mergeCaip2NetworkLimits(cardanoNetworks: Network[], caip2Networks: string[] = []): string[] {
	return Array.from(new Set([...cardanoNetworksToCaip2(cardanoNetworks), ...caip2Networks]));
}

export function isAllowedCaip2Network(networkLimit: string[] | null, caip2Network: string): boolean {
	if (networkLimit == null) {
		return true;
	}
	return networkLimit.includes(caip2Network);
}

export function convertNetwork(network: Network) {
	switch (network) {
		case 'Mainnet':
			return 'mainnet';
		case 'Preprod':
			return 'preprod';
		default:
			throw new Error('Invalid network');
	}
}

export function convertNetworkToId(network: Network) {
	switch (network) {
		case 'Mainnet':
			return 1;
		case 'Preprod':
			return 0;
		default:
			throw new Error('Invalid network');
	}
}
