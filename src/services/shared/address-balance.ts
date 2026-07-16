import { Network } from '@/generated/prisma/client';
import { getBlockfrostInstance } from '@/utils/blockfrost';

export type AddressBalanceAmount = {
	unit: string;
	quantity: string;
};

export type AddressBalanceMap = Map<string, bigint>;

export function toBalanceMapFromAddressAmounts(amounts: AddressBalanceAmount[]): AddressBalanceMap {
	const balanceMap: AddressBalanceMap = new Map();

	for (const amount of amounts) {
		const assetUnit = amount.unit === '' ? 'lovelace' : amount.unit;
		balanceMap.set(assetUnit, (balanceMap.get(assetUnit) ?? 0n) + BigInt(amount.quantity));
	}

	return balanceMap;
}

export async function fetchAddressBalance(params: {
	network: Network;
	rpcProviderApiKey: string;
	address: string;
}): Promise<AddressBalanceAmount[]> {
	const blockfrost = getBlockfrostInstance(params.network, params.rpcProviderApiKey);

	try {
		const addressDetails = await blockfrost.addresses(params.address);
		return addressDetails.amount;
	} catch (error) {
		const providerError = error as {
			status_code?: number | string;
			statusCode?: number | string;
		};
		if (Number(providerError.status_code ?? providerError.statusCode) === 404) {
			return [];
		}
		throw error;
	}
}

export async function fetchAddressBalanceMap(params: {
	network: Network;
	rpcProviderApiKey: string;
	address: string;
}): Promise<AddressBalanceMap> {
	return toBalanceMapFromAddressAmounts(await fetchAddressBalance(params));
}
