import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { metadataSchema } from '@/routes/api/registry/wallet';
import { metadataToString } from '@/utils/converter/metadata-string-convert';
import { z } from '@masumi/payment-core/zod';

const MAX_AGENT_NAME_LENGTH = 250;

function normalizeAgentName(name: string | null | undefined): string | null {
	const trimmed = name?.trim();
	if (!trimmed) return null;
	return trimmed.length > MAX_AGENT_NAME_LENGTH ? trimmed.slice(0, MAX_AGENT_NAME_LENGTH) : trimmed;
}

/** Reads the agent display name from on-chain registry metadata (no wallet-holding check). */
export async function lookupAgentNameFromOnChainMetadata(
	provider: BlockFrostAPI,
	agentIdentifier: string,
): Promise<string | null> {
	try {
		const assetMetadata = await provider.assetsById(agentIdentifier);
		if (!assetMetadata?.onchain_metadata) {
			return null;
		}
		const parsed = metadataSchema.safeParse(assetMetadata.onchain_metadata);
		if (!parsed.success) {
			return null;
		}
		return normalizeAgentName(metadataToString(parsed.data.name));
	} catch {
		return null;
	}
}

type FetchAssetInWalletAndMetadataSuccess = {
	data: {
		assetInWallet: Array<{ address: string }>;
		parsedMetadata: z.infer<typeof metadataSchema>;
	};
};

type FetchAssetInWalletAndMetadataError = {
	error: { code: number; description: string };
};

type FetchAssetInWalletAndMetadataResult = FetchAssetInWalletAndMetadataSuccess | FetchAssetInWalletAndMetadataError;

export const fetchAssetInWalletAndMetadata = async (
	provider: BlockFrostAPI,
	agentIdentifier: string,
): Promise<FetchAssetInWalletAndMetadataResult> => {
	let assetInWallet: Array<{ address: string }> = [];
	try {
		assetInWallet = await provider.assetsAddresses(agentIdentifier, {
			order: 'desc',
			count: 1,
		});
	} catch (error) {
		if (error instanceof Error && error.message.includes('404')) {
			return {
				error: { code: 404, description: 'Agent identifier not found' },
			};
		}
		return {
			error: { code: 500, description: 'Error fetching asset in wallet' },
		};
	}

	if (assetInWallet.length == 0) {
		return {
			error: { code: 404, description: 'Agent identifier not found' },
		};
	}

	const assetMetadata = await provider.assetsById(agentIdentifier);
	if (!assetMetadata || !assetMetadata.onchain_metadata) {
		return {
			error: { code: 404, description: 'Agent registry metadata not found' },
		};
	}
	const parsed = metadataSchema.safeParse(assetMetadata.onchain_metadata);
	if (!parsed.success) {
		return {
			error: { code: 404, description: 'Agent registry metadata not valid' },
		};
	}

	return { data: { assetInWallet, parsedMetadata: parsed.data } };
};
