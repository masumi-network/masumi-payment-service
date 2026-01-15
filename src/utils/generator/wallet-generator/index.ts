import { convertNetworkToId } from '@/utils/converter/network-convert';
import {
  BlockfrostProvider,
  MeshWallet,
  resolvePaymentKeyHash,
} from '@meshsdk/core';
import { Network } from '@/generated/prisma/client';
import { decrypt } from '@/utils/security/encryption';

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
) {
  const networkId = convertNetworkToId(network);
  const blockchainProvider = new BlockfrostProvider(rpcProviderApiKey);
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
