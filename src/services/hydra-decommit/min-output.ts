import createHttpError from 'http-errors';
import { getOutputMinLovelace, type Asset } from '@meshsdk/core';

/** Exact withdrawals must fail before submission rather than silently grow. */
export function assertDecommitOutputMinimum(address: string, amount: Asset[], coinsPerUtxoSize: number): void {
	if (!Number.isSafeInteger(coinsPerUtxoSize) || coinsPerUtxoSize <= 0) {
		throw createHttpError(502, 'Hydra head returned an invalid coinsPerUtxoSize');
	}
	const minimum = getOutputMinLovelace({ address, amount }, coinsPerUtxoSize);
	const lovelace = amount.reduce(
		(total, asset) => total + (asset.unit === 'lovelace' ? BigInt(asset.quantity) : 0n),
		0n,
	);
	if (lovelace < minimum) {
		throw createHttpError(
			400,
			`Withdrawal output contains ${lovelace} lovelace but requires at least ${minimum}. Increase the withdrawal amount or withdraw whole UTxOs.`,
		);
	}
}
