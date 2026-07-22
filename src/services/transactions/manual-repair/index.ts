import { Network, OnChainState, PaymentSourceType, Prisma, TransactionStatus } from '@/generated/prisma/client';
import { CONFIG } from '@masumi/payment-core/config';
import { prisma } from '@masumi/payment-core/db';
import { retryOnSerializationConflict } from '@masumi/payment-core/db-retry';
import { logger } from '@masumi/payment-core/logger';
import { onChainStateFromSmartContractState, SmartContractState } from '@masumi/payment-core/smart-contract-state';
import { deserializeDatum } from '@meshsdk/core';
import type { DecodedV1ContractDatum } from '@/utils/converter/string-datum-convert';
import { getDatumNetwork, getPaymentSourceContractAdapter } from '@/services/payment-source-adapters';
import { createApiClient } from '@/services/shared';
import { getChainErrorStatus } from '@/services/shared/chain-tx-lookup';
import { checkPaymentAmountsMatch } from '@/services/transactions/tx-sync/util';

export type RepairTargetKind = 'purchase' | 'payment';

export type RepairValidation = {
	txHash: string;
	outputIndex: number;
	derivedOnChainState: OnChainState;
	resultHash: string | null;
	confirmations: number;
	blockHeight: number;
	blockTime: number;
	blockchainIdentifierMatches: true;
};

type RepairWalletIdentity = {
	walletVkey: string;
	walletAddress: string;
};

export type RepairExpectedRequest = {
	kind: RepairTargetKind;
	inputHash: string;
	payByTime: bigint | null;
	submitResultTime: bigint;
	unlockTime: bigint;
	externalDisputeUnlockTime: bigint;
	collateralReturnLovelace: bigint | null;
	buyerReturnAddress: string | null;
	sellerReturnAddress: string | null;
	buyerWallet: RepairWalletIdentity | null;
	sellerWallet: RepairWalletIdentity | null;
	smartContractWallet: RepairWalletIdentity | null;
	amounts: Array<{ unit: string; amount: bigint }>;
	knownTransactionHashes: string[];
};

export type RepairExpectedVersion = {
	updatedAt: Date;
	currentTransactionId: string | null;
	onChainState: OnChainState | null;
	resultHash: string | null;
};

export class RepairValidationError extends Error {
	readonly detail: string;
	constructor(detail: string) {
		super(detail);
		this.name = 'RepairValidationError';
		this.detail = detail;
	}
}

/** A chain response was unavailable or incomplete, so validation is inconclusive. */
export class RepairChainLookupError extends Error {
	readonly providerStatus: number | undefined;
	constructor(message: string, providerStatus?: number) {
		super(message);
		this.name = 'RepairChainLookupError';
		this.providerStatus = providerStatus;
	}
}

/** The request changed after the route took the snapshot used for validation. */
export class RepairConflictError extends Error {
	constructor(requestId: string) {
		super(`Request ${requestId} changed while its repair transaction was being validated`);
		this.name = 'RepairConflictError';
	}
}

function nullableStringEquals(left: string | null | undefined, right: string | null | undefined) {
	return (left ?? null) === (right ?? null);
}

function optionalHashEquals(left: string | null | undefined, right: string | null | undefined) {
	return (left == null || left.length === 0 ? null : left) === (right == null || right.length === 0 ? null : right);
}

function walletMatches(expected: RepairWalletIdentity, vkey: string, address: string) {
	return expected.walletVkey === vkey && expected.walletAddress === address;
}

function paymentAmountsMatchExactly(
	expected: Array<{ unit: string; amount: bigint }>,
	actual: Array<{ unit: string; quantity: string }>,
	collateralReturnLovelace: bigint,
) {
	const expectedCopy = expected.map((amount) => ({ ...amount }));
	const actualCopy = actual.map((amount) => ({ ...amount }));
	if (!checkPaymentAmountsMatch(expectedCopy, actualCopy, collateralReturnLovelace)) return false;

	const expectedNativeUnits = new Set(
		expected
			.filter((amount) => amount.unit !== '' && amount.unit.toLowerCase() !== 'lovelace')
			.map((amount) => amount.unit),
	);
	return actual.every(
		(amount) => amount.unit === '' || amount.unit.toLowerCase() === 'lovelace' || expectedNativeUnits.has(amount.unit),
	);
}

/**
 * Returns the first immutable request field that differs from the chain datum.
 * Mutable state/result/cooldown fields are deliberately excluded.
 */
export function getRepairDatumMismatch(
	expected: RepairExpectedRequest,
	decoded: DecodedV1ContractDatum,
	paymentSourceType: PaymentSourceType,
): string | null {
	if (!optionalHashEquals(expected.inputHash, decoded.inputHash)) return 'inputHash';
	if (expected.payByTime == null || expected.payByTime !== decoded.payByTime) return 'payByTime';
	if (expected.submitResultTime !== decoded.resultTime) return 'submitResultTime';
	if (
		expected.kind === 'purchase' ? decoded.unlockTime < expected.unlockTime : decoded.unlockTime !== expected.unlockTime
	) {
		return 'unlockTime';
	}
	if (expected.externalDisputeUnlockTime !== decoded.externalDisputeUnlockTime) {
		return 'externalDisputeUnlockTime';
	}
	if (
		expected.collateralReturnLovelace == null ||
		expected.collateralReturnLovelace !== decoded.collateralReturnLovelace
	) {
		return 'collateralReturnLovelace';
	}

	if (expected.kind === 'payment') {
		if (expected.buyerWallet == null || !walletMatches(expected.buyerWallet, decoded.buyerVkey, decoded.buyerAddress)) {
			return 'buyerWallet';
		}
		if (
			expected.smartContractWallet == null ||
			!walletMatches(expected.smartContractWallet, decoded.sellerVkey, decoded.sellerAddress)
		) {
			return 'sellerWallet';
		}
	} else {
		if (
			expected.sellerWallet == null ||
			!walletMatches(expected.sellerWallet, decoded.sellerVkey, decoded.sellerAddress)
		) {
			return 'sellerWallet';
		}
		if (
			expected.smartContractWallet == null ||
			!walletMatches(expected.smartContractWallet, decoded.buyerVkey, decoded.buyerAddress)
		) {
			return 'buyerWallet';
		}
	}

	if (paymentSourceType === PaymentSourceType.Web3CardanoV2) {
		if (!nullableStringEquals(expected.buyerReturnAddress, decoded.buyerReturnAddress)) {
			return 'buyerReturnAddress';
		}
		if (!nullableStringEquals(expected.sellerReturnAddress, decoded.sellerReturnAddress)) {
			return 'sellerReturnAddress';
		}
	}

	return null;
}

function chainReadError(error: unknown, notFoundMessage?: string): Error {
	const providerStatus = getChainErrorStatus(error);
	if (notFoundMessage != null && providerStatus === 404) {
		return new RepairValidationError(notFoundMessage);
	}
	logger.warn('Chain provider could not complete manual repair validation', {
		providerStatus,
		error: error instanceof Error ? error.message : String(error),
	});
	return new RepairChainLookupError('Chain provider could not complete repair validation', providerStatus);
}

/**
 * Confirms that `txHash` really is this request's transaction, and derives the
 * on-chain state from its datum.
 *
 * This is the guard that makes manual repair safe to expose. Without it an
 * operator can point a request at an arbitrary transaction, and the automatic
 * refund/withdraw logic will then act on it — a typo becomes a wrong-UTxO spend
 * attempt. Everything here is checked against the chain, not against what the
 * caller claims:
 *
 *   1. the transaction exists,
 *   2. it has an output at THIS payment source's contract address,
 *   3. that output's datum decodes,
 *   4. and its blockchainIdentifier is this request's.
 *
 * Only then is the state read out of the datum. The caller never supplies it.
 */
export async function validateRepairTransaction(params: {
	txHash: string;
	blockchainIdentifier: string;
	smartContractAddress: string;
	network: Network;
	rpcProviderApiKey: string;
	paymentSourceType: PaymentSourceType;
	expectedRequest: RepairExpectedRequest;
}): Promise<RepairValidation> {
	const blockfrost = createApiClient(params.network, params.rpcProviderApiKey);
	const adapter = getPaymentSourceContractAdapter(params.paymentSourceType);

	let txDetails: Awaited<ReturnType<typeof blockfrost.txs>>;
	try {
		txDetails = await blockfrost.txs(params.txHash);
	} catch (error) {
		throw chainReadError(error, `Transaction ${params.txHash} was not found on chain`);
	}
	if (txDetails.valid_contract === false) {
		throw new RepairValidationError(
			`Transaction ${params.txHash} failed on-chain script validation and cannot be used for repair`,
		);
	}

	let confirmations = 0;
	if (CONFIG.BLOCK_CONFIRMATIONS_THRESHOLD > 0) {
		try {
			const block = await blockfrost.blocks(txDetails.block);
			confirmations = block.confirmations;
		} catch (error) {
			throw chainReadError(error);
		}
		if (confirmations < CONFIG.BLOCK_CONFIRMATIONS_THRESHOLD) {
			throw new RepairValidationError(
				`Transaction ${params.txHash} has ${confirmations} confirmation(s); ${CONFIG.BLOCK_CONFIRMATIONS_THRESHOLD} required`,
			);
		}
	}

	let utxos;
	try {
		utxos = await blockfrost.txsUtxos(params.txHash);
	} catch (error) {
		// The transaction lookup above succeeded. A subsequent 404/429/5xx here
		// is index lag or an outage, not evidence that the caller supplied a bad
		// transaction. Preserve it as a server error instead of returning 400.
		throw chainReadError(error);
	}

	const contractOutputs = utxos.outputs.filter((output) => output.address === params.smartContractAddress);
	if (contractOutputs.length === 0) {
		throw new RepairValidationError(
			`Transaction ${params.txHash} has no output at this payment source's contract address (${params.smartContractAddress}), so it cannot be this request's escrow transaction.`,
		);
	}

	const datumNetwork = getDatumNetwork(params.network);
	const spendableInputs = utxos.inputs.filter((input) => input.reference !== true && input.collateral !== true);
	const decodedContractInputs: Array<{ blockchainIdentifier: string; txHash: string }> = [];
	for (const input of spendableInputs) {
		if (input.address !== params.smartContractAddress || input.inline_datum == null) continue;
		try {
			const datum: unknown = deserializeDatum(input.inline_datum);
			const decodedInput = adapter.decodeContractDatum(datum, datumNetwork, params.smartContractAddress);
			if (decodedInput != null) {
				decodedContractInputs.push({
					blockchainIdentifier: decodedInput.blockchainIdentifier,
					txHash: input.tx_hash,
				});
			}
		} catch {
			// An undecodable contract input cannot prove this output continues the
			// request. The candidate below will fail closed on provenance.
		}
	}

	function getOutputProvenanceMismatch(
		decoded: DecodedV1ContractDatum,
		output: (typeof contractOutputs)[number],
	): string | null {
		if (output.reference_script_hash != null) return 'referenceScriptHash';

		if (!paymentAmountsMatchExactly(params.expectedRequest.amounts, output.amount, decoded.collateralReturnLovelace)) {
			return 'amounts';
		}

		const sameRequestContractInputs = decodedContractInputs.filter(
			(input) => input.blockchainIdentifier === decoded.blockchainIdentifier,
		);
		if (
			sameRequestContractInputs.some((input) => params.expectedRequest.knownTransactionHashes.includes(input.txHash))
		) {
			return null;
		}
		if (sameRequestContractInputs.length > 0) return 'transactionLineage';

		// Without a same-request contract input this can only be the initial
		// lock. A valid normal transaction may copy a datum to the script address,
		// so valid_contract=true alone is not provenance; the declared buyer must
		// actually fund the lock.
		if (decoded.state !== SmartContractState.FundsLocked) return 'transactionProvenance';
		if (!spendableInputs.some((input) => input.address === decoded.buyerAddress)) {
			return 'buyerFundingInput';
		}
		if (BigInt(txDetails.block_time) * 1000n > decoded.payByTime) return 'payByTimeDeadline';
		if (decoded.resultHash != null) return 'initialResultHash';
		if (decoded.buyerCooldownTime !== 0n) return 'buyerCooldownTime';
		if (decoded.sellerCooldownTime !== 0n) return 'sellerCooldownTime';
		return null;
	}

	let matchingDatumCount = 0;
	let matchingUnspentDatumCount = 0;
	let spentMatchingDatumCount = 0;
	let unknownSpentStatusCount = 0;
	let firstMismatch: string | null = null;
	const validUnspentOutputs: Array<{ outputIndex: number; decoded: DecodedV1ContractDatum }> = [];

	for (const output of contractOutputs) {
		if (output.inline_datum == null) continue;

		let decoded;
		try {
			const datum: unknown = deserializeDatum(output.inline_datum);
			decoded = adapter.decodeContractDatum(datum, datumNetwork, params.smartContractAddress);
		} catch {
			continue;
		}
		if (decoded == null) continue;
		if (decoded.blockchainIdentifier !== params.blockchainIdentifier) continue;
		matchingDatumCount += 1;

		if (output.consumed_by_tx === undefined) {
			unknownSpentStatusCount += 1;
			continue;
		}
		if (output.consumed_by_tx !== null) {
			spentMatchingDatumCount += 1;
			continue;
		}
		matchingUnspentDatumCount += 1;

		const mismatch = getRepairDatumMismatch(params.expectedRequest, decoded, params.paymentSourceType);
		if (mismatch != null) {
			firstMismatch ??= mismatch;
			continue;
		}
		const provenanceMismatch = getOutputProvenanceMismatch(decoded, output);
		if (provenanceMismatch != null) {
			firstMismatch ??= provenanceMismatch;
			continue;
		}
		validUnspentOutputs.push({ outputIndex: output.output_index, decoded });
	}

	if (matchingUnspentDatumCount > 1) {
		throw new RepairValidationError(
			`Transaction ${params.txHash} has multiple unspent contract outputs for this request; repair target is ambiguous`,
		);
	}
	if (unknownSpentStatusCount > 0) {
		throw new RepairChainLookupError(
			`Blockfrost did not report whether transaction ${params.txHash}'s matching output is spent; repair validation is inconclusive`,
		);
	}
	if (validUnspentOutputs.length === 1) {
		const validOutput = validUnspentOutputs[0];
		return {
			txHash: params.txHash,
			outputIndex: validOutput.outputIndex,
			derivedOnChainState: onChainStateFromSmartContractState(validOutput.decoded.state),
			resultHash:
				validOutput.decoded.resultHash == null || validOutput.decoded.resultHash.length === 0
					? null
					: validOutput.decoded.resultHash,
			confirmations,
			blockHeight: txDetails.block_height,
			blockTime: txDetails.block_time,
			blockchainIdentifierMatches: true,
		};
	}

	if (firstMismatch != null) {
		throw new RepairValidationError(
			`Transaction ${params.txHash} has this request's blockchainIdentifier, but datum field ${firstMismatch} does not match the request`,
		);
	}
	if (spentMatchingDatumCount > 0) {
		throw new RepairValidationError(
			`Transaction ${params.txHash} matches this request, but its contract output is already spent and is not the current escrow UTxO`,
		);
	}
	throw new RepairValidationError(
		`Transaction ${params.txHash} has ${contractOutputs.length} output(s) at the contract address, but none carries a valid datum for this request's blockchainIdentifier${matchingDatumCount > 0 ? ' and immutable fields' : ''}.`,
	);
}

/**
 * Finds or creates the Transaction row for a hash, without disturbing an
 * existing one.
 *
 * `Transaction.txHash` is not unique — the buyer and seller sides each keep
 * their own row for the same on-chain transaction — so this scopes the lookup
 * to rows already reachable from this request before falling back to creating
 * one.
 */
async function resolveTransactionRow(
	tx: Prisma.TransactionClient,
	params: {
		txHash: string;
		existingIds: string[];
		previousOnChainState: OnChainState | null;
		newOnChainState: OnChainState;
		validation: RepairValidation | null;
	},
): Promise<{ id: string; walletId: string | null }> {
	if (params.existingIds.length > 0) {
		const existing = await tx.transaction.findFirst({
			where: { id: { in: params.existingIds }, txHash: params.txHash },
			select: { id: true, BlocksWallet: { select: { id: true } } },
		});
		if (existing != null) {
			await tx.transaction.update({
				where: { id: existing.id },
				data: {
					status: TransactionStatus.Confirmed,
					previousOnChainState: params.previousOnChainState,
					newOnChainState: params.newOnChainState,
					...(params.validation == null
						? {}
						: {
								confirmations: params.validation.confirmations,
								blockHeight: params.validation.blockHeight,
								blockTime: params.validation.blockTime,
								validContract: true,
							}),
				},
			});
			return { id: existing.id, walletId: existing.BlocksWallet?.id ?? null };
		}
	}

	const created = await tx.transaction.create({
		data: {
			txHash: params.txHash,
			status: TransactionStatus.Confirmed,
			previousOnChainState: params.previousOnChainState,
			newOnChainState: params.newOnChainState,
			...(params.validation == null
				? {}
				: {
						confirmations: params.validation.confirmations,
						blockHeight: params.validation.blockHeight,
						blockTime: params.validation.blockTime,
						validContract: true,
					}),
		},
		select: { id: true },
	});
	return { id: created.id, walletId: null };
}

async function releaseTransactionWallet(
	tx: Prisma.TransactionClient,
	transactionId: string,
	walletId: string | null,
): Promise<void> {
	if (walletId == null) return;

	await tx.hotWallet.updateMany({
		where: { id: walletId, pendingTransactionId: transactionId },
		data: { pendingTransactionId: null, lockedAt: null },
	});
}

async function hasOtherCurrentTransactionReferences(
	tx: Prisma.TransactionClient,
	params: { transactionId: string; requestId: string; kind: RepairTargetKind },
): Promise<boolean> {
	const paymentRequestCount = await tx.paymentRequest.count({
		where: {
			currentTransactionId: params.transactionId,
			...(params.kind === 'payment' ? { id: { not: params.requestId } } : {}),
		},
	});
	if (paymentRequestCount > 0) return true;

	const purchaseRequestCount = await tx.purchaseRequest.count({
		where: {
			currentTransactionId: params.transactionId,
			...(params.kind === 'purchase' ? { id: { not: params.requestId } } : {}),
		},
	});
	if (purchaseRequestCount > 0) return true;

	// Payment transactions should not normally be shared with these flows, but
	// Transaction is a common lifecycle table. Fail closed before terminating a
	// row that any other live workflow still owns.
	if ((await tx.registryRequest.count({ where: { currentTransactionId: params.transactionId } })) > 0) return true;
	if ((await tx.inboxAgentRegistrationRequest.count({ where: { currentTransactionId: params.transactionId } })) > 0) {
		return true;
	}
	if ((await tx.fundDistributionRequest.count({ where: { transactionId: params.transactionId } })) > 0) return true;
	return (await tx.walletFundTransfer.count({ where: { transactionId: params.transactionId } })) > 0;
}

function requestVersionMatches(
	request: {
		updatedAt: Date;
		currentTransactionId: string | null;
		onChainState: OnChainState | null;
		resultHash: string | null;
	},
	expected: RepairExpectedVersion,
) {
	return (
		request.updatedAt.getTime() === expected.updatedAt.getTime() &&
		request.currentTransactionId === expected.currentTransactionId &&
		request.onChainState === expected.onChainState &&
		request.resultHash === expected.resultHash
	);
}

export type RepairResult = {
	requestId: string;
	txHash: string;
	transactionId: string;
	previousOnChainState: OnChainState | null;
	newOnChainState: OnChainState;
	forced: boolean;
};

/**
 * Repoints a purchase or payment at `txHash` and brings its on-chain state to
 * match.
 *
 * Exists because recovering from a sync gap otherwise requires hand-written SQL
 * against production: find the escrow UTxO, match its datum, re-insert the
 * TransactionHistory row, repoint currentTransactionId. That is error-prone
 * under pressure — during the incident this was written for, the first attempt
 * repaired the wrong transaction.
 */
export async function repairRequestTransaction(params: {
	kind: RepairTargetKind;
	requestId: string;
	txHash: string;
	validation: RepairValidation | null;
	forcedOnChainState: OnChainState | null;
	expectedVersion: RepairExpectedVersion;
}): Promise<RepairResult> {
	const forced = params.validation == null;
	const newOnChainState = params.validation?.derivedOnChainState ?? params.forcedOnChainState;
	if (newOnChainState == null) {
		throw new RepairValidationError('An on-chain state must be supplied when validation is skipped');
	}

	// Serializable + conflict retry: this races tx-sync, which may be applying
	// the very transaction being repaired. Without it a concurrent handler could
	// interleave between our read and write and one of the two updates would be
	// silently lost. Same pattern as error-state-recovery.
	const result = await retryOnSerializationConflict(() =>
		prisma.$transaction(
			async (tx) => {
				const request =
					params.kind === 'purchase'
						? await tx.purchaseRequest.findUnique({
								where: { id: params.requestId },
								select: {
									id: true,
									updatedAt: true,
									onChainState: true,
									resultHash: true,
									currentTransactionId: true,
									CurrentTransaction: {
										select: { status: true, BlocksWallet: { select: { id: true } } },
									},
									TransactionHistory: { select: { id: true } },
								},
							})
						: await tx.paymentRequest.findUnique({
								where: { id: params.requestId },
								select: {
									id: true,
									updatedAt: true,
									onChainState: true,
									resultHash: true,
									currentTransactionId: true,
									CurrentTransaction: {
										select: { status: true, BlocksWallet: { select: { id: true } } },
									},
									TransactionHistory: { select: { id: true } },
								},
							});

				if (request == null) {
					throw new RepairValidationError(`${params.kind} request ${params.requestId} not found`);
				}
				if (!requestVersionMatches(request, params.expectedVersion)) {
					throw new RepairConflictError(params.requestId);
				}

				const existingIds = [
					...request.TransactionHistory.map((x) => x.id),
					...(request.currentTransactionId != null ? [request.currentTransactionId] : []),
				];

				const targetTransaction = await resolveTransactionRow(tx, {
					txHash: params.txHash,
					existingIds,
					previousOnChainState: request.onChainState,
					newOnChainState,
					validation: params.validation,
				});
				await releaseTransactionWallet(tx, targetTransaction.id, targetTransaction.walletId);

				if (
					request.currentTransactionId != null &&
					request.currentTransactionId !== targetTransaction.id &&
					request.CurrentTransaction != null
				) {
					const hasOtherReferences = await hasOtherCurrentTransactionReferences(tx, {
						transactionId: request.currentTransactionId,
						requestId: params.requestId,
						kind: params.kind,
					});
					if (!hasOtherReferences) {
						if (request.CurrentTransaction.status === TransactionStatus.Pending) {
							await tx.transaction.updateMany({
								where: { id: request.currentTransactionId, status: TransactionStatus.Pending },
								data: { status: TransactionStatus.FailedViaManualReset },
							});
						}
						await releaseTransactionWallet(
							tx,
							request.currentTransactionId,
							request.CurrentTransaction.BlocksWallet?.id ?? null,
						);
					}
				}

				// Connect to history as well as current. A terminal action has no later
				// step to archive it, and an entry missing from history is invisible to
				// error-state-recovery's candidate selection.
				const data = {
					currentTransactionId: targetTransaction.id,
					onChainState: newOnChainState,
					...(params.validation == null ? {} : { resultHash: params.validation.resultHash }),
					TransactionHistory: {
						connect: Array.from(
							new Set([
								targetTransaction.id,
								...(request.currentTransactionId == null ? [] : [request.currentTransactionId]),
							]),
						).map((id) => ({ id })),
					},
				};

				if (params.kind === 'purchase') {
					await tx.purchaseRequest.update({ where: { id: params.requestId }, data });
				} else {
					await tx.paymentRequest.update({ where: { id: params.requestId }, data });
				}

				return {
					requestId: params.requestId,
					txHash: params.txHash,
					transactionId: targetTransaction.id,
					previousOnChainState: request.onChainState,
					newOnChainState,
					forced,
				};
			},
			{ isolationLevel: 'Serializable' },
		),
	);

	logger.warn('Request transaction repaired manually', {
		kind: params.kind,
		requestId: params.requestId,
		txHash: params.txHash,
		transactionId: result.transactionId,
		previousOnChainState: result.previousOnChainState,
		newOnChainState: result.newOnChainState,
		forced,
	});

	return result;
}
