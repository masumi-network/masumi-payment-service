import { convertNetworkToId } from '@/utils/converter/network-convert';
import { MeshWallet, resolvePaymentKeyHash } from '@meshsdk/core';
import { Network } from '@/generated/prisma/client';
import { decrypt } from '@/utils/security/encryption';
import { HydraProvider } from '@/lib/hydra';
import { getCachedBlockfrostProvider } from '@/utils/mesh-cost-model-sync';

export function generateOfflineWallet(network: Network, mnemonic: string[]) {
	const networkId = convertNetworkToId(network);
	return new MeshWallet({
		networkId: networkId,
		key: {
			type: 'mnemonic',
			words: mnemonic,
		},
	});
}

export async function generateWalletExtended(
	network: Network,
	rpcProviderApiKey: string,
	encryptedSecret: string,
	hydraProvider?: HydraProvider,
) {
	const networkId = convertNetworkToId(network);
	const blockchainProvider = hydraProvider ?? getCachedBlockfrostProvider(rpcProviderApiKey);
	const mnemonic = decrypt(encryptedSecret).split(' ');
	const wallet = new MeshWallet({
		networkId: networkId,
		fetcher: blockchainProvider,
		submitter: blockchainProvider,
		key: {
			type: 'mnemonic',
			words: mnemonic,
		},
	});

	const address = (await wallet.getUnusedAddresses())[0];
	const utxos = await wallet.getUtxos();
	const vKey = resolvePaymentKeyHash(address);

	return { address, utxos, wallet, blockchainProvider, vKey };
}
