/**
 * Refuse a new Head before Init when its live L2 ledger could create outputs
 * that the current L1 ledger cannot settle. This check is deliberately fresh:
 * the readiness drift check caches values and returns no drift on lookup errors.
 */

import type { Network } from '@/generated/prisma/client';
import {
	EXPECTED_MAX_TX_SIZE,
	FANOUT_ENVELOPE_BYTES,
	FANOUT_SAFETY_MARGIN_BYTES,
} from '@/lib/hydra/hydra/params-drift';
import { getBlockfrostInstance } from '@/utils/blockfrost';
import { findParamDrift } from '@/utils/hydra/params-drift';
import { getOwnValue, isPlainObject } from '@masumi/payment-core/object-properties';
import createHttpError from 'http-errors';

function positiveSafeInteger(value: unknown, allowDecimalString: boolean): number | null {
	if (allowDecimalString && typeof value === 'string') {
		if (!/^[1-9]\d*$/.test(value)) return null;
		value = Number(value);
	}
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function requiredInteger(parameters: unknown, field: string, ledger: 'L1' | 'L2'): number {
	const value = isPlainObject(parameters) ? positiveSafeInteger(getOwnValue(parameters, field), ledger === 'L1') : null;
	if (value === null) {
		throw createHttpError(ledger === 'L1' ? 503 : 409, `${ledger} protocol parameters report no usable ${field}`);
	}
	return value;
}

export async function assertSafeInitLedgerParams(params: {
	ledgerParams: unknown;
	network: Network;
	rpcProviderApiKey: string | null | undefined;
}): Promise<void> {
	const maxTxSize = requiredInteger(params.ledgerParams, 'maxTxSize', 'L2');
	if (maxTxSize > EXPECTED_MAX_TX_SIZE) {
		throw createHttpError(
			409,
			`This head's node runs an L2 maxTxSize of ${maxTxSize}, above ${EXPECTED_MAX_TX_SIZE}. ` +
				'A head on it can hold an output no fanout can move to L1. Start the node on ledger params ' +
				`with maxTxSize ${EXPECTED_MAX_TX_SIZE} or less, then retry`,
		);
	}
	const maxValueSize = requiredInteger(params.ledgerParams, 'maxValueSize', 'L2');
	const utxoCostPerByte = requiredInteger(params.ledgerParams, 'utxoCostPerByte', 'L2');
	if (!params.rpcProviderApiKey) {
		throw createHttpError(409, 'This head has no independent L1 observer configured for Init');
	}

	let chainParams: unknown;
	try {
		chainParams = await getBlockfrostInstance(params.network, params.rpcProviderApiKey).epochsLatestParameters();
	} catch {
		throw createHttpError(503, 'Could not read current L1 protocol parameters; Init was not posted', { expose: true });
	}
	const chainMaxTxSize = requiredInteger(chainParams, 'max_tx_size', 'L1');
	const chainMaxValueSize = requiredInteger(chainParams, 'max_val_size', 'L1');
	const chainUtxoCostPerByte = requiredInteger(chainParams, 'coins_per_utxo_size', 'L1');

	if (maxTxSize + FANOUT_ENVELOPE_BYTES + FANOUT_SAFETY_MARGIN_BYTES > chainMaxTxSize) {
		throw createHttpError(
			409,
			`This head's L2 maxTxSize of ${maxTxSize} leaves no fanout room under the current L1 ` +
				`maxTxSize of ${chainMaxTxSize}; Init was not posted`,
		);
	}
	const unsafeDrift = findParamDrift(
		{ maxValueSize, utxoCostPerByte },
		{ maxValueSize: chainMaxValueSize, utxoCostPerByte: chainUtxoCostPerByte },
	).find((drift) => drift.blocksFanout);
	if (unsafeDrift) {
		throw createHttpError(
			409,
			`This head's L2 ${unsafeDrift.parameter} is ${unsafeDrift.head}, but current L1 is ` +
				`${unsafeDrift.chain}. Outputs created in this head may fail fanout; Init was not posted`,
		);
	}
}
