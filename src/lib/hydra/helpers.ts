import { BlockfrostProvider, Network } from '@meshsdk/core';

export function extractNetworkFromProjectId(projectId: string): Network {
	const network = projectId.slice(0, 7);
	switch (network) {
		case 'preprod':
			return 'preprod';
		case 'mainnet':
			return 'mainnet';
		case 'preview':
			return 'preview';
		default:
			throw new Error(`Unknown network: ${network}`);
	}
}

export function makeBlockfrostProviderFromProjectId(projectId: string): BlockfrostProvider {
	return new BlockfrostProvider(projectId);
}
