import { Network } from '@/generated/prisma/client';

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
