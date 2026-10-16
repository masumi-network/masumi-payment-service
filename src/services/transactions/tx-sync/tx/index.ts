import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { Network, OnChainState, PaymentSource, PaymentSourceType } from '@/generated/prisma/client';
import {
	calculateValueChange,
	checkIfTxIsInHistory,
	checkPaymentAmountsMatch,
	ExtractedTransactionEntry,
	ExtractOnChainTransactionDataOutput,
	getCardanoFeesBuyer,
	getCardanoFeesSeller,
	redeemerToOnChainState,
} from '@/services/transactions/tx-sync/util';
import { deserializeDatum } from '@meshsdk/core';
import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { getDatumNetwork, getPaymentSourceContractAdapter } from '@/services/payment-source-adapters';
import { TxSyncBeforeWrite } from '../quarantine/fenced-write';
import {
	handleV1PaymentTransaction,
	handleV1PurchasingTransaction,
} from '@masumi/payment-source-v1/services/tx-sync/handlers';
import {
	handleV2PaymentTransaction,
	handleV2PurchasingTransaction,
} from '@masumi/payment-source-v2/services/tx-sync/handlers';
import type { UpdateTransactionInput } from './types';
import { verifyRequestFieldsAgainstDatum, v2ReturnAddressesMatch } from './datum-verification';
import { updateInitialPurchaseTransaction } from './initial-purchase';
import { updateInitialPaymentTransaction } from './initial-payment';

export type { UpdateTransactionInput } from './types';
export { updateRolledBackTransaction } from './rolled-back';

export async function updateInitialTransactions(
	valueOutputs: Extract<ExtractOnChainTransactionDataOutput, { type: 'Initial' }>['valueOutputs'],
	paymentContract: {
		id: string;
		network: Network;
		paymentSourceType: PaymentSourceType;
		smartContractAddress: string;
	},
	tx: UpdateTransactionInput,
	rpcProviderApiKey: string,
	beforeWrite?: TxSyncBeforeWrite,
) {
	// Pre-filter to valid initial outputs (datum present AND decodes against the
	// payment-source adapter). V2 batch txs emit one continuation output per
	// locked request, so a single tx can carry N valid outputs. Charging the
	// full `tx.metadata.fees` to EACH output's buyer would N-times-over-credit
	// the fee column. Pro-rate the total fee by the number of valid outputs;
	// the first valid output absorbs any rounding remainder so the sum across
	// outputs equals the full tx fee exactly. V1 (and non-batch V2) always has
	// exactly one valid Initial output, so the share equals the full fee and
	// behavior is unchanged.
	const adapter = getPaymentSourceContractAdapter(paymentContract.paymentSourceType);
	const datumNetwork = getDatumNetwork(paymentContract.network);
	type ValidOutput = {
		output: (typeof valueOutputs)[number];
		decodedNewContract: NonNullable<ReturnType<typeof adapter.decodeContractDatum>>;
	};
	const validOutputs: ValidOutput[] = [];
	for (const output of valueOutputs) {
		const outputDatum = output.inline_datum;
		if (outputDatum == null) continue;
		const decodedOutputDatum: unknown = deserializeDatum(outputDatum);
		const decodedNewContract = adapter.decodeContractDatum(
			decodedOutputDatum,
			datumNetwork,
			paymentContract.smartContractAddress,
		);
		if (decodedNewContract == null) continue;
		validOutputs.push({ output, decodedNewContract });
	}

	if (validOutputs.length === 0) return;

	const totalFees = tx.metadata.fees;
	const validCount = BigInt(validOutputs.length);
	const baseShare = totalFees / validCount;
	const remainder = totalFees - baseShare * validCount;

	for (let i = 0; i < validOutputs.length; i++) {
		const { output, decodedNewContract } = validOutputs[i];
		const buyerCardanoFees = baseShare + (i === 0 ? remainder : 0n);
		const sellerCardanoFees = BigInt(0);

		await updateInitialPurchaseTransaction(
			paymentContract,
			decodedNewContract,
			output,
			tx,
			tx.metadata,
			buyerCardanoFees,
			sellerCardanoFees,
			beforeWrite,
		);

		await updateInitialPaymentTransaction(
			decodedNewContract,
			paymentContract,
			tx,
			output,
			tx.metadata,
			buyerCardanoFees,
			sellerCardanoFees,
			rpcProviderApiKey,
			beforeWrite,
		);
	}
}

/**
 * Process ONE input/output pair from a (possibly batched) smart-contract tx.
 *
 * Single-redeemer V1 txs call this once. Multi-redeemer V2 batch txs call
 * this N times (once per `ExtractedTransactionEntry` in
 * `extractedData.entries`). Each invocation maps to exactly one
 * `PaymentRequest` / `PurchaseRequest` row via the entry's
 * `decodedOldContract.blockchainIdentifier`.
 */
export async function updateTransaction(
	paymentContract: PaymentSource,
	entry: ExtractedTransactionEntry,
	blockfrost: BlockFrostAPI,
	tx: UpdateTransactionInput,
	beforeWrite?: TxSyncBeforeWrite,
) {
	// Look up the request by `blockchainIdentifier` only (single-field @unique).
	// Time-window and party-vkey fields are verified post-fetch with
	// null-tolerant equality so legacy rows predating the payByTime column
	// (added in migration 20250622215253_add_pay_by_time without a backfill,
	// schema declares `payByTime BigInt?`) are still picked up. Pre-fetch
	// equality on `payByTime: <bigint>` in `findUnique` would silently miss
	// rows with `payByTime IS NULL`, dropping confirmations for those rows.
	//
	// Spoofing defence is preserved: when the DB value is non-null and does
	// not match the on-chain datum, we log + return without writing through.
	let paymentRequest = await prisma.paymentRequest.findUnique({
		where: {
			blockchainIdentifier: entry.decodedOldContract.blockchainIdentifier,
		},
		include: {
			BuyerWallet: true,
			SmartContractWallet: { where: { deletedAt: null } },
			RequestedFunds: true,
			NextAction: true,
			CurrentTransaction: true,
			TransactionHistory: true,
		},
	});
	if (paymentRequest != null) {
		if (paymentRequest.paymentSourceId !== paymentContract.id) {
			// Row belongs to a different payment source. Ignore this side
			// during the current source's pass, but keep checking the purchase
			// side below in case it legitimately belongs here.
			logger.warn('tx-sync: ignoring payment request row from a different payment source', {
				txHash: tx.tx.tx_hash,
				blockchainIdentifier: entry.decodedOldContract.blockchainIdentifier,
				currentPaymentSourceId: paymentContract.id,
				requestPaymentSourceId: paymentRequest.paymentSourceId,
				paymentRequestId: paymentRequest.id,
			});
			paymentRequest = null;
		} else if (!verifyRequestFieldsAgainstDatum(paymentRequest, entry.decodedOldContract, 'payment', tx.tx.tx_hash)) {
			return;
		}
	}
	let purchasingRequest = await prisma.purchaseRequest.findUnique({
		where: {
			blockchainIdentifier: entry.decodedOldContract.blockchainIdentifier,
		},
		include: {
			SmartContractWallet: { where: { deletedAt: null } },
			SellerWallet: true,
			NextAction: true,
			CurrentTransaction: true,
			PaidFunds: true,
			TransactionHistory: true,
		},
	});
	if (purchasingRequest != null) {
		if (purchasingRequest.paymentSourceId !== paymentContract.id) {
			logger.warn('tx-sync: ignoring purchase request row from a different payment source', {
				txHash: tx.tx.tx_hash,
				blockchainIdentifier: entry.decodedOldContract.blockchainIdentifier,
				currentPaymentSourceId: paymentContract.id,
				requestPaymentSourceId: purchasingRequest.paymentSourceId,
				purchaseRequestId: purchasingRequest.id,
			});
			purchasingRequest = null;
		} else if (
			!verifyRequestFieldsAgainstDatum(purchasingRequest, entry.decodedOldContract, 'purchase', tx.tx.tx_hash)
		) {
			return;
		}
	}

	if (paymentRequest == null && purchasingRequest == null) {
		// Transaction is not registered with us or duplicated (therefore
		// invalid). WARN, not info: tx-sync's checkpoint advances past this
		// tx and we'll never re-evaluate it. If an operator later wires up a
		// matching request row (data migration, manual repair), they need
		// this signal to find the historical tx for manual replay.
		// Default log levels include warn; downgrading to info would hide
		// the signal under steady-state noise.
		logger.warn(
			'tx-sync: skipping tx — no matching request row for blockchainIdentifier (checkpoint will advance past this tx)',
			{
				txHash: tx.tx.tx_hash,
				blockchainIdentifier: entry.decodedOldContract.blockchainIdentifier,
				paymentSourceId: paymentContract.id,
				actionable:
					'If a request row is added later that maps to this blockchainIdentifier, replay the tx via the admin recovery path — tx-sync will not revisit it.',
			},
		);
		return;
	}

	const inputTxHashMatchPaymentRequest = await checkIfTxIsInHistory(
		paymentRequest?.CurrentTransaction?.txHash ?? 'no-tx',
		paymentRequest?.TransactionHistory ?? [],
		blockfrost,
		paymentContract.smartContractAddress,
		tx,
	);
	if (inputTxHashMatchPaymentRequest == false) {
		logger.warn('Input tx hash does not match payment request tx hash. This likely is a spoofing attempt', {
			paymentRequest: paymentRequest,
			txHash: tx.tx.tx_hash,
		});
	}
	const inputTxHashMatchPurchasingRequest = await checkIfTxIsInHistory(
		purchasingRequest?.CurrentTransaction?.txHash ?? 'no-tx',
		purchasingRequest?.TransactionHistory ?? [],
		blockfrost,
		paymentContract.smartContractAddress,
		tx,
	);
	if (inputTxHashMatchPurchasingRequest == false) {
		logger.warn('Input tx hash does not match purchasing request tx hash. This likely is a spoofing attempt', {
			purchasingRequest: purchasingRequest,
			txHash: tx.tx.tx_hash,
		});
	}

	let sellerWithdrawn: Array<{
		unit: string;
		quantity: bigint;
	}> = [];
	let buyerWithdrawn: Array<{
		unit: string;
		quantity: bigint;
	}> = [];

	const valueMatches = checkPaymentAmountsMatch(
		paymentRequest?.RequestedFunds ?? purchasingRequest?.PaidFunds ?? [],
		entry.valueOutput?.amount ?? [],
		entry.decodedOldContract.collateralReturnLovelace,
	);
	if (
		paymentContract.paymentSourceType === PaymentSourceType.Web3CardanoV2 &&
		entry.decodedNewContract != null &&
		!v2ReturnAddressesMatch(entry.decodedOldContract, entry.decodedNewContract)
	) {
		logger.warn('Return addresses changed in V2 contract datum. This likely is a spoofing attempt.', {
			txHash: tx.tx.tx_hash,
			oldBuyerReturnAddress: entry.decodedOldContract.buyerReturnAddress,
			newBuyerReturnAddress: entry.decodedNewContract.buyerReturnAddress,
			oldSellerReturnAddress: entry.decodedOldContract.sellerReturnAddress,
			newSellerReturnAddress: entry.decodedNewContract.sellerReturnAddress,
		});
		return;
	}

	const buyerCardanoFees = getCardanoFeesBuyer(
		entry.redeemerVersion,
		entry.feesShare,
		paymentContract.paymentSourceType,
	);
	const sellerCardanoFees = getCardanoFeesSeller(
		entry.redeemerVersion,
		entry.feesShare,
		paymentContract.paymentSourceType,
	);

	const newState: OnChainState | null = redeemerToOnChainState(
		entry.redeemerVersion,
		entry.decodedNewContract,
		valueMatches,
	);

	if (!newState) {
		logger.error(
			'Unexpected redeemer version detected. Possible invalid state in smart contract or bug in the software. tx_hash: ' +
				tx.tx.tx_hash,
		);
		return;
	}

	if (newState == OnChainState.DisputedWithdrawn) {
		sellerWithdrawn = calculateValueChange(tx.utxos.inputs, tx.utxos.outputs, entry.decodedOldContract.sellerVkey);

		buyerWithdrawn = calculateValueChange(tx.utxos.inputs, tx.utxos.outputs, entry.decodedOldContract.buyerVkey);
	}

	// Per-handler try/catch lets both halves run independently (an entry can
	// map to both a paymentRequest and a purchasingRequest), but a failure
	// in EITHER must propagate up so the outer tx-sync loop does NOT advance
	// the checkpoint past this tx. If we swallowed silently, the affected
	// request would stay stuck at its pre-tx state forever (no future sync
	// tick re-processes a tx whose checkpoint has already passed). The
	// handlers are idempotent on retry (see the early-return guards at the
	// top of each) so re-processing the whole tx next tick is safe.
	let paymentHandlerError: unknown;
	let purchasingHandlerError: unknown;
	// Exhaustive route by paymentSourceType. The `assertNever` default forces
	// adding a new PaymentSourceType enum value to be a TypeScript compile
	// error — without it, a future enum addition would silently advance the
	// tx-sync checkpoint while the new source's confirmations went unprocessed.
	let paymentHandler: typeof handleV1PaymentTransaction;
	let purchasingHandler: typeof handleV1PurchasingTransaction;
	switch (paymentContract.paymentSourceType) {
		case PaymentSourceType.Web3CardanoV1:
			paymentHandler = handleV1PaymentTransaction;
			purchasingHandler = handleV1PurchasingTransaction;
			break;
		case PaymentSourceType.Web3CardanoV2:
			paymentHandler = handleV2PaymentTransaction;
			purchasingHandler = handleV2PurchasingTransaction;
			break;
		default: {
			const _exhaustive: never = paymentContract.paymentSourceType;
			// Throw, do NOT silently return. The outer tx-sync loop catches
			// throws and HALTS the per-source checkpoint advance, which is
			// the only safe outcome here: a new PaymentSourceType variant
			// added to Prisma without a matching handler arm above would
			// otherwise silently skip confirmation processing for that
			// source's txs while the checkpoint advanced past them
			// — irrecoverable without a re-sync from scratch.
			throw new Error(
				`Unsupported paymentSourceType '${String(_exhaustive)}' for tx-sync confirmation handlers; checkpoint advance HALTED to prevent silent skip. tx_hash=${tx.tx.tx_hash}`,
			);
		}
	}
	try {
		if (inputTxHashMatchPaymentRequest) {
			// NOTE: NextAction.requestedAction is intentionally NOT passed — the
			// handler re-reads it inside its Serializable tx to avoid the stale-
			// predecessor race where a batch service pre-submit could swap it
			// between this outer read and the handler's tx open.
			await paymentHandler(
				tx.tx.tx_hash,
				newState,
				paymentContract.id,
				entry.decodedOldContract.blockchainIdentifier,
				entry.decodedNewContract?.resultHash ?? entry.decodedOldContract.resultHash,
				entry.decodedNewContract?.buyerCooldownTime ?? 0n,
				entry.decodedNewContract?.sellerCooldownTime ?? 0n,
				sellerWithdrawn,
				buyerWithdrawn,
				tx.block.confirmations,
				tx.metadata,
				buyerCardanoFees,
				sellerCardanoFees,
				beforeWrite,
			);
		}
	} catch (error) {
		paymentHandlerError = error;
		logger.error('Error handling payment transaction', {
			error: error,
		});
	}
	try {
		if (inputTxHashMatchPurchasingRequest) {
			await purchasingHandler(
				tx.tx.tx_hash,
				newState,
				paymentContract.id,
				entry.decodedOldContract.blockchainIdentifier,
				entry.decodedNewContract?.resultHash ?? entry.decodedOldContract.resultHash,
				entry.decodedNewContract?.buyerCooldownTime ?? 0n,
				entry.decodedNewContract?.sellerCooldownTime ?? 0n,
				sellerWithdrawn,
				buyerWithdrawn,
				tx.block.confirmations,
				tx.metadata,
				buyerCardanoFees,
				sellerCardanoFees,
				beforeWrite,
			);
		}
	} catch (error) {
		purchasingHandlerError = error;
		logger.error('Error handling purchasing transaction', {
			error: error,
		});
	}
	// Both handlers ran independently. When BOTH failed, surface both
	// causes via AggregateError so the outer scheduler log captures the
	// payment-side AND purchase-side error chains. Previously the second
	// throw discarded the payment-side error and operators had to
	// reconstruct half the failure from earlier log lines.
	if (paymentHandlerError != null && purchasingHandlerError != null) {
		throw new AggregateError(
			[paymentHandlerError, purchasingHandlerError],
			'Both payment-side and purchase-side handlers failed for tx-sync entry',
		);
	}
	if (paymentHandlerError != null) {
		throw paymentHandlerError as Error;
	}
	if (purchasingHandlerError != null) {
		throw purchasingHandlerError as Error;
	}
}
