import { CONSTANTS } from '@masumi/payment-core/config';
import {
	DecodedV1ContractDatum,
	decodeV1ContractDatum,
	decodeV2ContractDatum,
} from '@/utils/converter/string-datum-convert';
import { SmartContractState } from '@/utils/generator/contract-generator';
import { logger } from '@masumi/payment-core/logger';
import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { PlutusDatumSchema, RedeemerTagKind, Transaction } from '@emurgo/cardano-serialization-lib-nodejs';
import { deserializeDatum, resolvePaymentKeyHash } from '@meshsdk/core';
import { Network, OnChainState, PaymentSourceType } from '@/generated/prisma/client';
import { getSmartContractInteractionTxHistoryList, TransactionMetadata } from '../blockchain';

export function calculateValueChange(
	inputs: Array<{
		address: string;
		amount: Array<{ unit: string; quantity: string }>;
		tx_hash: string;
		output_index: number;
		data_hash: string | null;
		inline_datum: string | null;
		reference_script_hash: string | null;
		collateral: boolean;
		reference?: boolean;
	}>,
	outputs: Array<{
		address: string;
		amount: Array<{ unit: string; quantity: string }>;
		output_index: number;
		data_hash: string | null;
		inline_datum: string | null;
		collateral: boolean;
		reference_script_hash: string | null;
		consumed_by_tx?: string | null;
	}>,
	vkey: string,
) {
	const withdrawnAmount: Array<{ unit: string; quantity: bigint }> = [];
	const inputAmounts = inputs.filter((x) => resolvePaymentKeyHash(x.address) == vkey).map((x) => x.amount);
	const outputAmounts = outputs.filter((x) => resolvePaymentKeyHash(x.address) == vkey).map((x) => x.amount);

	outputAmounts.forEach((output) => {
		output.forEach((amount) => {
			const outputAmounts = withdrawnAmount.find((x) => {
				return x.unit == amount.unit;
			});
			if (outputAmounts == null) {
				const amountNumber = BigInt(amount.quantity);
				withdrawnAmount.push({
					unit: amount.unit,
					quantity: amountNumber,
				});
			} else {
				outputAmounts.quantity += BigInt(amount.quantity);
			}
		});
	});
	inputAmounts.forEach((input) => {
		input.forEach((amount) => {
			const withdrawnAmounts = withdrawnAmount.find((x) => {
				return x.unit == amount.unit;
			});
			if (withdrawnAmounts == null) {
				const amountNumber = -BigInt(amount.quantity);
				withdrawnAmount.push({
					unit: amount.unit,
					quantity: amountNumber,
				});
			} else {
				withdrawnAmounts.quantity -= BigInt(amount.quantity);
			}
		});
	});
	return withdrawnAmount;
}

export function checkPaymentAmountsMatch(
	expectedAmounts: Array<{ unit: string; amount: bigint }>,
	actualAmounts: Array<{ unit: string; quantity: string }>,
	collateralReturn: bigint,
) {
	if (collateralReturn < 0n) {
		return false;
	}
	if (collateralReturn > 0n && collateralReturn < CONSTANTS.MIN_COLLATERAL_LOVELACE) {
		return false;
	}
	return expectedAmounts.every((x) => {
		if (x.unit.toLowerCase() == 'lovelace') {
			x.unit = '';
		}
		const existingAmount = actualAmounts.find((y) => {
			if (y.unit.toLowerCase() == 'lovelace') {
				y.unit = '';
			}
			return y.unit == x.unit;
		});
		if (existingAmount == null) return false;
		//allow for some overpayment to handle min lovelace requirements
		if (x.unit == '') {
			return x.amount <= BigInt(existingAmount.quantity) - collateralReturn;
		}
		//require exact match for non-lovelace amounts
		return x.amount == BigInt(existingAmount.quantity);
	});
}

// `tx.fees` is the WHOLE tx fee. With multi-redeemer batches, each per-entry
// `updateTransaction` call shouldn't book the whole-tx fee — it should book
// its share. The `share` param accepts a pre-computed slice (e.g.
// `tx.fees / entries.length` for an even split). Single-redeemer V1 txs pass
// `share = tx.fees` to preserve the original behavior.
export function getCardanoFeesSeller(redeemerVersion: number, share: bigint) {
	if (redeemerVersion == 0) {
		//Withdraw
		return share;
	} else if (redeemerVersion == 5) {
		//SubmitResult
		return share;
	} else if (redeemerVersion == 6) {
		//AllowRefund
		return share;
	}
	return BigInt(0);
}

export function getCardanoFeesBuyer(redeemerVersion: number, share: bigint) {
	if (redeemerVersion == 1) {
		//RequestRefund
		return share;
	} else if (redeemerVersion == 2) {
		//CancelRefundRequest
		return share;
	} else if (redeemerVersion == 3) {
		//WithdrawRefund
		return share;
	} else if (redeemerVersion == 6) {
		//WithdrawDisputed
		return share;
	}
	return BigInt(0);
}

export function redeemerToOnChainState(
	redeemerVersion: number,
	decodedNewContract: {
		resultHash: string | null;
		state: SmartContractState;
	} | null,
	valueMatches: boolean,
) {
	if (redeemerVersion == 0) {
		//Withdraw
		return OnChainState.Withdrawn;
	} else if (redeemerVersion == 1) {
		//RequestRefund
		if (decodedNewContract?.resultHash && decodedNewContract.resultHash != '') {
			return OnChainState.Disputed;
		} else {
			return OnChainState.RefundRequested;
		}
	} else if (redeemerVersion == 2) {
		if (decodedNewContract?.state == SmartContractState.WithdrawAuthorized) {
			return OnChainState.WithdrawAuthorized;
		}
		//CancelRefundRequest / AuthorizeWithdrawal
		if (decodedNewContract?.resultHash != null && decodedNewContract?.resultHash != '') {
			return decodedNewContract.state == SmartContractState.Disputed
				? OnChainState.Disputed
				: OnChainState.ResultSubmitted;
		} else {
			//Ensure the amounts match, to prevent state change attacks

			return valueMatches == true ? OnChainState.FundsLocked : OnChainState.FundsOrDatumInvalid;
		}
	} else if (redeemerVersion == 3) {
		//WithdrawRefund
		return OnChainState.RefundWithdrawn;
	} else if (redeemerVersion == 4) {
		//WithdrawDisputed
		return OnChainState.DisputedWithdrawn;
	} else if (redeemerVersion == 5) {
		//SubmitResult
		if (
			decodedNewContract?.state == SmartContractState.RefundRequested ||
			decodedNewContract?.state == SmartContractState.Disputed
		) {
			return OnChainState.Disputed;
		} else {
			return OnChainState.ResultSubmitted;
		}
	} else if (redeemerVersion == 6) {
		//AllowRefund / AuthorizeRefund
		return decodedNewContract?.state == SmartContractState.RefundAuthorized
			? OnChainState.RefundAuthorized
			: OnChainState.RefundRequested;
	} else {
		//invalid transaction
		return null;
	}
}

type ScriptValueInput = {
	address: string;
	amount: Array<{ unit: string; quantity: string }>;
	tx_hash: string;
	output_index: number;
	data_hash: string | null;
	inline_datum: string | null;
	reference_script_hash: string | null;
	collateral: boolean;
	reference?: boolean;
};

type ScriptValueOutput = {
	address: string;
	amount: Array<{ unit: string; quantity: string }>;
	output_index: number;
	data_hash: string | null;
	inline_datum: string | null;
	collateral: boolean;
	reference_script_hash: string | null;
	consumed_by_tx?: string | null;
};

/**
 * One (script-input, paired-continuation-output) pair extracted from a tx.
 *
 * Single-redeemer V1 txs produce exactly ONE entry (the historical shape).
 * V2 batch txs (multiple smart-contract spends in one tx) produce N entries.
 * Each entry feeds one `updateTransaction` call which maps to exactly one
 * `PaymentRequest` / `PurchaseRequest` row via `decodedOldContract.blockchainIdentifier`.
 */
export type ExtractedTransactionEntry = {
	redeemerVersion: number;
	// Position of this redeemer's input in the canonically-sorted tx body
	// inputs list. Mesh-sdk and the ledger both index `RedeemerTag::Spend`
	// against this sort, NOT against off-chain `.txIn()` call order. We store
	// it so downstream code (e.g. fee allocation by ex_units) can correlate.
	redeemerIndex: number;
	valueInput: ScriptValueInput;
	valueOutput: ScriptValueOutput | null;
	decodedOldContract: DecodedV1ContractDatum;
	decodedNewContract: DecodedV1ContractDatum | null;
	// Pro-rated tx fee attributable to this entry. Whole-tx fee is split
	// evenly across entries (`tx.fees / N`). Per-redeemer ex_units-weighted
	// pro-rating would be more precise but requires re-evaluating the tx; an
	// even split is exact for same-kind batches (every action of the same
	// kind has the same fee responsibility V1/V2-wise).
	feesShare: bigint;
};

export type ExtractOnChainTransactionDataOutput =
	| { type: 'Initial'; valueOutputs: ScriptValueOutput[] }
	| { type: 'Invalid'; error: string }
	| {
			type: 'Transaction';
			// Shared tx context, kept once so call sites avoid recomputing it
			// across entries.
			valueInputs: ScriptValueInput[];
			valueOutputs: ScriptValueOutput[];
			entries: ExtractedTransactionEntry[];
	  };

export function extractOnChainTransactionData(
	tx: {
		blockTime: number;
		tx: {
			tx_hash: string;
		};
		block: {
			confirmations: number;
		};
		metadata: TransactionMetadata;
		utxos: {
			hash: string;
			inputs: ScriptValueInput[];
			outputs: ScriptValueOutput[];
		};
		transaction: Transaction;
	},
	paymentContract: { smartContractAddress: string; network: Network; paymentSourceType: PaymentSourceType },
): ExtractOnChainTransactionDataOutput {
	const valueInputs = tx.utxos.inputs.filter((x) => {
		return x.address == paymentContract.smartContractAddress;
	});
	const valueOutputs = tx.utxos.outputs.filter((x) => {
		return x.address == paymentContract.smartContractAddress;
	});
	if (valueOutputs.find((output) => output.reference_script_hash != null)) {
		return {
			type: 'Invalid',
			error: 'Smart Contract value output has reference script set',
		};
	}
	const redeemers = tx.transaction.witness_set().redeemers();
	if (valueInputs.length == 0 && !redeemers) return { type: 'Initial', valueOutputs };
	if (valueInputs.length == 0) {
		return {
			type: 'Invalid',
			error: 'Smart Contract has redeemers but no value inputs at the contract address',
		};
	}
	if (!redeemers) {
		return {
			type: 'Invalid',
			error: 'Smart Contract redeemer invalid',
		};
	}
	if (valueInputs.some((input) => input.reference_script_hash)) {
		return {
			type: 'Invalid',
			error: 'Smart Contract value input has reference script set',
		};
	}
	if (valueInputs.some((input) => input.inline_datum == null)) {
		return {
			type: 'Invalid',
			error: 'Smart Contract value input has no datum',
		};
	}

	const datumNetwork = paymentContract.network == Network.Mainnet ? 'mainnet' : 'preprod';
	const decodeDatum = (datum: unknown): DecodedV1ContractDatum | null =>
		paymentContract.paymentSourceType === PaymentSourceType.Web3CardanoV2
			? decodeV2ContractDatum(datum, datumNetwork, paymentContract.smartContractAddress)
			: decodeV1ContractDatum(datum, datumNetwork);

	// Build a map from "canonical sorted tx body input index" → ScriptValueInput.
	// Cardano serializes inputs as a sorted set keyed by (tx_id, output_index)
	// before computing the script_data_hash, and the ledger's Redeemer.index
	// for `Spend` references THAT sorted position — NOT the order in which
	// inputs were added off-chain. We use the parsed Transaction body's input
	// list (which IS the canonical sorted set) as the index reference.
	const bodyInputs = tx.transaction.body().inputs();
	const scriptInputsByBodyIndex = new Map<number, ScriptValueInput>();
	for (let i = 0; i < bodyInputs.len(); i++) {
		const bodyInput = bodyInputs.get(i);
		const txHash = Buffer.from(bodyInput.transaction_id().to_bytes()).toString('hex');
		const outputIndex = bodyInput.index();
		const matched = valueInputs.find((vi) => vi.tx_hash === txHash && vi.output_index === outputIndex);
		if (matched != null) {
			scriptInputsByBodyIndex.set(i, matched);
		}
	}

	// Walk every redeemer; pair the `Spend` ones with their script input, decode
	// the input's datum, and find the matching continuation output via the
	// datum's `referenceSignature` (which the on-chain validator keeps stable
	// across transitions and uniquely identifies a payment thread). Terminal
	// redeemers (Withdraw=0, WithdrawRefund=3, WithdrawDisputed=4) have no
	// continuation output → `valueOutput: null`.
	//
	// Outputs at the script address that are NOT continuation datums (e.g. the
	// `OutputReference == own_ref` tagged outputs for buyer-collateral-return
	// in V2 Withdraw) are ignored here — those don't have a payment-thread
	// `referenceSignature`.
	const entries: ExtractedTransactionEntry[] = [];
	const decodedOutputs = valueOutputs.map((output) => {
		const decodedOutputDatum: unknown = output.inline_datum != null ? deserializeDatum(output.inline_datum) : null;
		return { output, decoded: decodeDatum(decodedOutputDatum) };
	});
	const usedOutputIndices = new Set<number>();

	for (let i = 0; i < redeemers.len(); i++) {
		const redeemer = redeemers.get(i);
		if (redeemer.tag().kind() !== RedeemerTagKind.Spend) continue;
		const redeemerIndex = Number(redeemer.index().to_str());
		const valueInput = scriptInputsByBodyIndex.get(redeemerIndex);
		if (valueInput == null) continue;

		const decodedInputDatum: unknown = deserializeDatum(valueInput.inline_datum as string);
		const decodedOldContract = decodeDatum(decodedInputDatum);
		if (decodedOldContract == null) {
			return {
				type: 'Invalid',
				error: 'Smart Contract value input has no decodable datum',
			};
		}

		const redeemerJson = redeemer.data().to_json(PlutusDatumSchema.BasicConversions);
		const redeemerJsonObject = JSON.parse(redeemerJson) as { constructor: number };
		const redeemerVersion = redeemerJsonObject.constructor;

		// Pair with continuation output by reference_signature. For a tx with
		// only one script input + one script output (the historical V1 case),
		// the pairing collapses to direct position correspondence; reference
		// signatures still match because both datums share the field.
		let pairedOutputIdx = -1;
		for (let j = 0; j < decodedOutputs.length; j++) {
			if (usedOutputIndices.has(j)) continue;
			const candidate = decodedOutputs[j];
			if (candidate.decoded == null) continue;
			if (candidate.decoded.referenceSignature === decodedOldContract.referenceSignature) {
				pairedOutputIdx = j;
				break;
			}
		}
		const valueOutput = pairedOutputIdx >= 0 ? decodedOutputs[pairedOutputIdx].output : null;
		const decodedNewContract = pairedOutputIdx >= 0 ? decodedOutputs[pairedOutputIdx].decoded : null;
		if (pairedOutputIdx >= 0) {
			usedOutputIndices.add(pairedOutputIdx);
		}

		// Terminal redeemers (Withdraw, WithdrawRefund, WithdrawDisputed) are
		// allowed to have no continuation. All others MUST have one.
		if (redeemerVersion !== 0 && redeemerVersion !== 3 && redeemerVersion !== 4 && decodedNewContract == null) {
			logger.warn('No continuation output paired with non-terminal redeemer', {
				txHash: tx.tx.tx_hash,
				redeemerVersion,
				inputTxHash: valueInput.tx_hash,
				inputOutputIndex: valueInput.output_index,
			});
			return {
				type: 'Invalid',
				error: 'Possible invalid state in smart contract detected',
			};
		}

		entries.push({
			redeemerVersion,
			redeemerIndex,
			valueInput,
			valueOutput,
			decodedOldContract,
			decodedNewContract,
			// Even fee split. Refined per-redeemer ex_units weighting would
			// require running `evaluateTx` again on sync, which is wasteful.
			// Same-kind batches have the same fee responsibility so the split
			// is exact for the realistic case.
			feesShare: BigInt(0), // placeholder; filled after loop once N is known
		});
	}

	if (entries.length === 0) {
		return {
			type: 'Invalid',
			error: 'Smart Contract redeemer set has no matching Spend redeemer for a script input',
		};
	}

	// Continuation outputs at the script address that didn't pair with any
	// input's reference_signature: phase-1-valid but unexpected. Flag as
	// invalid so we don't silently mis-attribute funds.
	const unpaired = decodedOutputs.filter((o, idx) => o.decoded != null && !usedOutputIndices.has(idx));
	if (unpaired.length > 0) {
		return {
			type: 'Invalid',
			error: `Smart Contract has ${unpaired.length} continuation output(s) with no matching input reference_signature`,
		};
	}

	// Pro-rate the whole-tx fee evenly across entries. Integer-divide with
	// remainder applied to the first entry so the per-entry sum equals the
	// total fee exactly (no rounding loss).
	const totalFees = tx.metadata.fees;
	const n = BigInt(entries.length);
	const perEntry = totalFees / n;
	const remainder = totalFees - perEntry * n;
	const entriesWithFees = entries.map((entry, idx) => ({
		...entry,
		feesShare: idx === 0 ? perEntry + remainder : perEntry,
	}));

	return {
		type: 'Transaction',
		valueInputs,
		valueOutputs,
		entries: entriesWithFees,
	};
}

export async function checkIfTxIsInHistory(
	currentTxHash: string | undefined,
	transactionHistory: Array<{
		txHash: string | null;
	}>,
	blockfrost: BlockFrostAPI,
	smartContractAddress: string,
	tx: {
		blockTime: number;
		tx: { tx_hash: string };
		block: { confirmations: number };
		utxos: {
			hash: string;
			inputs: Array<{
				address: string;
				amount: Array<{ unit: string; quantity: string }>;
				tx_hash: string;
				output_index: number;
				data_hash: string | null;
				inline_datum: string | null;
				reference_script_hash: string | null;
				collateral: boolean;
				reference?: boolean;
			}>;
			outputs: Array<{
				address: string;
				amount: Array<{ unit: string; quantity: string }>;
				output_index: number;
				data_hash: string | null;
				inline_datum: string | null;
				collateral: boolean;
				reference_script_hash: string | null;
				consumed_by_tx?: string | null;
			}>;
		};
		transaction: Transaction;
	},
) {
	if (currentTxHash == tx.tx.tx_hash) {
		return true;
	}
	const txHistory = await getSmartContractInteractionTxHistoryList(
		blockfrost,
		smartContractAddress,
		tx.tx.tx_hash,
		currentTxHash ?? 'no-tx',
	);
	//find tx hash in history
	for (const txHash of txHistory) {
		if (currentTxHash == txHash || transactionHistory.find((x) => x.txHash == txHash) != null) {
			return true;
		}
	}

	return false;
}
