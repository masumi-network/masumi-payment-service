import { Network } from '@/generated/prisma/client';
import { isCardanoAddressForNetwork } from '@/types/payment-source';

export function isCardanoAddress(address: string): boolean {
	return isCardanoAddressForNetwork(address, Network.Mainnet) || isCardanoAddressForNetwork(address, Network.Preprod);
}
