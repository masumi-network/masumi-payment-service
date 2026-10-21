import { HydraProtocolError } from './errors';
import { EXPECTED_MAX_TX_SIZE } from './params-drift';

/**
 * Refuse an L2 tx larger than the L2 `maxTxSize` this service ships.
 *
 * A head on the shipped ledger rejects it anyway. A head started on the older
 * 16,384 would accept it, and an output it creates could then be too large for
 * any fanout to move. Call it before reserving anything for the tx: after the
 * reservation, a refusal at submit reads as an ambiguous outcome and holds it.
 *
 * `maxTxSize` is the head's own limit where the caller has it, already capped
 * at the shipped one by `fetchHydraProtocolParameters`: a head on a smaller
 * limit would reject a tx this function let through.
 */
export function assertL2TxWithinMaxSize(cborHex: string, maxTxSize: number = EXPECTED_MAX_TX_SIZE): void {
	const bytes = cborHex.length / 2;
	if (bytes > maxTxSize) {
		throw new HydraProtocolError(`L2 transaction is ${bytes} bytes, above the ${maxTxSize}-byte L2 limit`);
	}
}
