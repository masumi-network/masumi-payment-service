/**
 * The in-head split a withdrawal runs before it can take an exact amount.
 *
 * A decommit removes every output of its transaction from the head, so part of
 * a UTxO cannot leave on its own: the amount is first carved onto its own UTxO
 * by an ordinary in-head transaction, and the decommit then spends that.
 */

import createHttpError from 'http-errors';
import { MeshTxBuilder, MeshWallet, resolveTxHash, type UTxO } from '@meshsdk/core';
import { Network } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { CustomHydraHead, HydraProvider, HydraTransactionType } from '@/lib/hydra';
import { convertNetwork } from '@/utils/converter/network-convert';
import { amountOf, countNativeAssets, lovelaceOf, utxoRef } from './select';
import { assertDecommitOutputMinimum } from './min-output';
import { assertL2TxWithinMaxSize } from '@/lib/hydra/hydra/l2-tx-size';

/**
 * How long the in-head split gets to confirm before the withdrawal gives up.
 *
 * An in-head transaction is a signature exchange between the parties, so this is
 * generous by two orders of magnitude. It exists for the case where the
 * counterparty has gone quiet mid-split, which would otherwise hold the
 * participant's only withdrawal slot open indefinitely.
 */
const SPLIT_CONFIRM_TIMEOUT_MS = 60_000;
const SPLIT_POLL_MS = 500;

/**
 * Lovelace carried by a carved token output.
 *
 * A Cardano output cannot hold a token without enough ADA to exist, so an exact
 * token withdrawal takes this along and returns it to the wallet with the
 * asset. Comfortably above the minimum for a single-asset output.
 */
export const TOKEN_OUTPUT_LOVELACE = 2_000_000n;

/**
 * Marks the failure of an in-head split that was sent and not seen confirmed.
 *
 * The head may still apply it, so its inputs stay spoken for.
 */
export const SPLIT_MAY_STILL_CONFIRM = Symbol.for('masumi.hydra.decommit.splitMayStillConfirm');

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Carve the exact amount into its own in-head UTxO.
 *
 * Ordinary in-head transaction: inputs from the wallet, one output of exactly
 * the requested lovelace, the remainder as change back to the same address.
 * Both outputs stay in the head — only the decommit that follows removes
 * anything.
 */
export async function splitExactAmountInHead(params: {
	wallet: MeshWallet;
	provider: HydraProvider;
	hydraHead: CustomHydraHead;
	address: string;
	network: Network;
	inputs: UTxO[];
	/** Empty unit means lovelace. */
	unit: string;
	amount: bigint;
	decommitId: string;
}): Promise<{ txId: string; exact: UTxO }> {
	const { wallet, provider, hydraHead, address, network, inputs, unit, amount, decommitId } = params;
	const isLovelace = unit === '' || unit.toLowerCase() === 'lovelace';

	// The head's OWN ledger parameters, fetched from the head, never assumed.
	//
	// An in-head transaction is validated by the head's ledger, not L1's, and
	// this head charges no fee at all (txFeeFixed 0, txFeePerByte 0, execution
	// prices 0) while still enforcing a real minimum-UTxO and 150% collateral.
	// Built without them, Mesh applied mainnet fee parameters to a transaction
	// that never leaves the head: the fee was simply burned, and burning it
	// changed the head's ADA overhead. `headAdaOverhead` is an invariant the
	// head validator checks on every transition — mustPreserveHeadAdaOverhead,
	// error H65 — so each fee-paying withdrawal moved the head one step further
	// from ever being closeable.
	//
	// Fetched rather than flagged. MeshTxBuilder's `isHydra` shortcut zeroes the
	// fee knobs but also sets collateralPercent to 0, which this head does not
	// agree with, and it would silently diverge from any head configured
	// differently.
	const headParameters = await provider.fetchProtocolParameters();
	const builder = new MeshTxBuilder({
		fetcher: provider,
		submitter: provider,
		params: headParameters,
		verbose: false,
	});
	for (const utxo of inputs) {
		builder.txIn(utxo.input.txHash, utxo.input.outputIndex, utxo.output.amount, utxo.output.address);
	}
	// A token cannot travel on its own: every output needs enough lovelace to
	// exist, so the carved UTxO carries the asked-for amount plus that floor, and
	// the floor comes back with it when the withdrawal lands.
	const carvedValue = isLovelace
		? [{ unit: 'lovelace', quantity: amount.toString() }]
		: [
				{ unit: 'lovelace', quantity: TOKEN_OUTPUT_LOVELACE.toString() },
				{ unit, quantity: amount.toString() },
			];
	assertDecommitOutputMinimum(address, carvedValue, headParameters.coinsPerUtxoSize);
	const unsignedTx = await builder
		.txOut(address, carvedValue)
		.changeAddress(address)
		.setNetwork(convertNetwork(network))
		.complete();
	const signedTx = await wallet.signTx(unsignedTx, true);
	assertSendableInHead(signedTx, headParameters.maxTxSize);
	const splitTxId = resolveTxHash(signedTx) as string;

	await prisma.hydraDecommit.update({ where: { id: decommitId }, data: { splitTxId } });

	await hydraHead.newTx({ type: HydraTransactionType.TxConwayEra, description: '', cborHex: signedTx });

	// Wait for the head to confirm it before spending its output. The head's own
	// confirmation is the only evidence that the split exists; building the
	// decommit against an unconfirmed output would be refused as an unknown input.
	const deadline = Date.now() + SPLIT_CONFIRM_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (hydraHead.mainNode.isTxConfirmed(splitTxId)) break;
		await sleep(SPLIT_POLL_MS);
	}
	if (!hydraHead.mainNode.isTxConfirmed(splitTxId)) {
		throw Object.assign(
			createHttpError(
				504,
				`The in-head split ${splitTxId} was not confirmed within ${SPLIT_CONFIRM_TIMEOUT_MS / 1000}s; nothing has left the head`,
			),
			{ [SPLIT_MAY_STILL_CONFIRM]: true },
		);
	}

	// Find the carved output by value. The builder places the explicit output
	// before the change, but reading the index off that convention would break
	// silently if it ever changed; matching on the amount cannot.
	const produced = await provider.fetchUTxOs(splitTxId);
	const exact = produced.find(
		(utxo) =>
			utxo.output.address === address &&
			amountOf(utxo, isLovelace ? '' : unit) === amount &&
			// A lovelace carve's change can hold the same lovelace plus the
			// tokens it kept. Only the pure output may leave the head.
			(isLovelace ? countNativeAssets(utxo) === 0 : lovelaceOf(utxo) === TOKEN_OUTPUT_LOVELACE),
	);
	if (!exact) {
		throw createHttpError(
			502,
			`The in-head split ${splitTxId} confirmed but produced no output of exactly ${amount} ${isLovelace ? 'lovelace' : unit}`,
		);
	}
	logger.info(`[HydraDecommit] split ${amount} ${isLovelace ? 'lovelace' : unit} into ${utxoRef(exact)} in head`);
	return { txId: splitTxId, exact };
}

/** A tx this service would refuse to send in a head, as the client error it is. */
export function assertSendableInHead(signedTx: string, maxTxSize: number): void {
	try {
		assertL2TxWithinMaxSize(signedTx, maxTxSize);
	} catch (error) {
		throw createHttpError(
			422,
			`${errorMessage(error)}. Consolidate the wallet in the head first, or withdraw a smaller amount`,
		);
	}
}
