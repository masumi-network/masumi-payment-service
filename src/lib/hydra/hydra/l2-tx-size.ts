import { HydraProtocolError } from './errors';
import { EXPECTED_MAX_TX_SIZE } from './params-drift';

/**
 * Refuse an L2 tx larger than the L2 `maxTxSize` this service ships.
 *
 * A head on the shipped ledger rejects it anyway. A head started on the older
 * 16,384 would accept it, and an output it creates could then be too large for
 * any fanout to move. Call it before reserving anything for the tx: after the
 * reservation, a refusal at submit reads as an ambiguous outcome and holds it.
 */
export function assertL2TxWithinMaxSize(cborHex: string): void {
	const bytes = cborHex.length / 2;
	if (bytes > EXPECTED_MAX_TX_SIZE) {
		throw new HydraProtocolError(
			`L2 transaction is ${bytes} bytes; the L2 ledger this service ships allows at most ${EXPECTED_MAX_TX_SIZE}`,
		);
	}
}
