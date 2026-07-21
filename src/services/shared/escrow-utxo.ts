import { IFetcher, UTxO } from '@meshsdk/core';

export const ESCROW_UTXO_SPENT_MESSAGE =
	'Escrow UTxO is already spent on chain. The recorded transaction state is stale; wait for tx-sync to observe the new on-chain state before retrying.';

/**
 * Confirms the escrow UTxO the action is about to spend is still unspent.
 *
 * `BlockfrostProvider.fetchUTxOs(txHash)` resolves `GET /txs/{hash}/utxos`,
 * which returns every OUTPUT of that transaction whether or not it has since
 * been consumed. Matching the escrow datum against that list therefore
 * succeeds even for an output another transaction already spent, and the
 * service happily builds a transaction spending it.
 *
 * The ledger only rejects it at evaluation time, and the rejection is opaque:
 * Ogmios cannot resolve the input, so it cannot see that the input is
 * script-locked, and reports the (correctly indexed) spend redeemer as
 * `extraRedeemers` instead of an unknown-input error. Checking the address's
 * live UTxO set turns that into a diagnosable failure at the point of cause.
 */
export async function assertEscrowUtxoUnspent(
	blockchainProvider: IFetcher,
	smartContractAddress: string,
	utxo: UTxO,
): Promise<void> {
	const liveUtxos = await blockchainProvider.fetchAddressUTxOs(smartContractAddress);
	const isUnspent = liveUtxos.some(
		(liveUtxo) => liveUtxo.input.txHash === utxo.input.txHash && liveUtxo.input.outputIndex === utxo.input.outputIndex,
	);
	if (!isUnspent) {
		throw new Error(`${ESCROW_UTXO_SPENT_MESSAGE} (${utxo.input.txHash}#${utxo.input.outputIndex})`);
	}
}
