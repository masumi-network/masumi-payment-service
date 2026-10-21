/**
 * The one L2 ledger setting a Host refuses to run without: a `maxTxSize` small
 * enough that fanout can move every output a head can create.
 *
 * An L2 tx can create an output almost as large as the L2 `maxTxSize`, and a
 * fanout tx must carry that output to L1 inside a tx 917 bytes larger. A head
 * whose limit leaves no room for that can hold an output that keeps it from
 * ever reaching Final (docs/hydra-fanout-output-size-measurement.md).
 *
 * Checked at boot for every network, because the params file is an operator
 * setting (`HYDRA_HOST_LEDGER_PARAMS_FILE`) and mainnet ships no reviewed file.
 */

import { readFileSync } from 'node:fs';

/** L1 Conway `maxTxSize` on preprod and mainnet. */
export const L1_MAX_TX_SIZE = 16_384;

/**
 * Bytes a hydra-node 2.4.1 fanout tx adds around one distributed output,
 * measured on devnet. Re-measure on a hydra-node version change.
 */
export const FANOUT_ENVELOPE_BYTES = 917;

/**
 * Largest L2 `maxTxSize` a Host runs. 467 bytes of the L1 limit stay free for
 * what the measurement could not fix. The payment service expects the same
 * value (`EXPECTED_MAX_TX_SIZE` in src/lib/hydra/hydra/params-drift.ts); src/
 * does not depend on this package, so change both.
 */
export const MAX_L2_TX_SIZE = 15_000;

/** Throws unless the ledger params file sets a `maxTxSize` fanout can always settle. */
export function assertLedgerParamsSettleable(file: string): void {
	let maxTxSize: unknown;
	try {
		maxTxSize = (JSON.parse(readFileSync(file, 'utf8')) as { maxTxSize?: unknown }).maxTxSize;
	} catch (error) {
		throw new Error(`cannot read the ledger protocol parameters at ${file}: ${(error as Error).message}`);
	}
	if (typeof maxTxSize !== 'number' || !Number.isInteger(maxTxSize) || maxTxSize <= 0) {
		throw new Error(`the ledger protocol parameters at ${file} set no usable maxTxSize`);
	}
	if (maxTxSize > MAX_L2_TX_SIZE) {
		throw new Error(
			`the ledger protocol parameters at ${file} set maxTxSize ${maxTxSize}, above ${MAX_L2_TX_SIZE}. ` +
				'A head on them can hold an output no fanout transaction can move to L1, and then never reaches Final. ' +
				`Set maxTxSize to ${MAX_L2_TX_SIZE} or less, and restart nodes on the new file only between heads`,
		);
	}
}
