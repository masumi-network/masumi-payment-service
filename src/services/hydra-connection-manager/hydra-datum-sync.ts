import { CONSTANTS } from '@masumi/payment-core/config';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { checkPaymentAmountsMatch } from '@masumi/payment-core/payment-amounts';
import { decodeBlockchainIdentifier } from '@masumi/payment-core/blockchain-identifier';
import { deserializeDatum } from '@meshsdk/core';
import { Constr, Data } from 'lucid-cardano';
import {
	OnChainState,
	Network,
	PaymentAction,
	HotWalletType,
	Prisma,
	PurchasingAction,
	TransactionLayer,
	TransactionStatus,
	WalletType,
} from '@/generated/prisma/client';
import { decodeV2ContractDatum, type DecodedV1ContractDatum } from '@/utils/converter/string-datum-convert';
import { datumMatchesRequest, validateL2InitialLock } from '@/utils/logic/l2-datum-validation';
import { convertNewPaymentActionAndError, convertNewPurchasingActionAndError } from '@/utils/logic/state-transitions';
import {
	canonicalizeHydraAmounts,
	hydraAmountListCovers,
	hydraAmountListsEqual,
	hydraValidityLowerBoundTimeMs,
	hydraValidityUpperBoundTimeMs,
	type HydraAmount,
	type HydraTransactionEvidence,
} from './hydra-transaction-evidence';
import { resolveHydraL2EvidenceSlotConfig } from '@/utils/hydra/l2-slot-context';
import { convertNetwork } from '@/utils/converter/network-convert';
import { hasHydraRequestOwnership, resolveEffectiveForceLayer } from '@/utils/logic/force-layer';

export type HydraOutputReference = { txHash: string; outputIndex: number };
export type HydraDatumApplyOutcome = 'applied' | 'irrelevant' | 'retry';

/**
 * Resolve only duplicate identifiers that can affect this payment source's
 * local escrow rows. Anyone can fund a script address with arbitrary datum
 * bytes, so unrelated duplicate outputs must not retain the whole head's
 * ordered replay queue.
 */
export async function findLocallyRelevantHydraRequestIdentifiers(
	paymentSourceId: string,
	identifiers: Iterable<string>,
): Promise<Set<string>> {
	const uniqueIdentifiers = [...new Set(identifiers)];
	if (uniqueIdentifiers.length === 0) return new Set();
	const [paymentRequests, purchaseRequests] = await Promise.all([
		prisma.paymentRequest.findMany({
			where: { paymentSourceId, blockchainIdentifier: { in: uniqueIdentifiers } },
			select: { blockchainIdentifier: true },
		}),
		prisma.purchaseRequest.findMany({
			where: { paymentSourceId, blockchainIdentifier: { in: uniqueIdentifiers } },
			select: { blockchainIdentifier: true },
		}),
	]);
	return new Set([
		...paymentRequests.map(({ blockchainIdentifier }) => blockchainIdentifier),
		...purchaseRequests.map(({ blockchainIdentifier }) => blockchainIdentifier),
	]);
}

function headParticipantsMatch(
	decoded: DecodedV1ContractDatum,
	_side: 'payment' | 'purchase',
	head: {
		HydraRelation: {
			LocalHotWallet: { walletVkey: string; walletAddress: string; paymentSourceId: string };
			RemoteWallet: { walletVkey: string; walletAddress: string; paymentSourceId: string };
		};
	},
	paymentSourceId: string,
): boolean {
	const local = head.HydraRelation.LocalHotWallet;
	const remote = head.HydraRelation.RemoteWallet;
	if (local.paymentSourceId !== paymentSourceId || remote.paymentSourceId !== paymentSourceId) return false;
	const localIsBuyer =
		decoded.buyerVkey === local.walletVkey &&
		decoded.buyerAddress === local.walletAddress &&
		decoded.sellerVkey === remote.walletVkey &&
		decoded.sellerAddress === remote.walletAddress;
	const localIsSeller =
		decoded.sellerVkey === local.walletVkey &&
		decoded.sellerAddress === local.walletAddress &&
		decoded.buyerVkey === remote.walletVkey &&
		decoded.buyerAddress === remote.walletAddress;
	return localIsBuyer || localIsSeller;
}

function requestParticipantsMatch(
	side: 'payment' | 'purchase',
	request: {
		BuyerWallet?: { walletVkey: string; walletAddress: string } | null;
		SellerWallet?: { walletVkey: string; walletAddress: string } | null;
		SmartContractWallet: { walletVkey: string; walletAddress: string } | null;
	},
	head: {
		HydraRelation: {
			LocalHotWallet: { walletVkey: string; walletAddress: string; paymentSourceId: string };
			RemoteWallet: { walletVkey: string; walletAddress: string; paymentSourceId: string };
		};
	},
	paymentSourceId: string,
): boolean {
	const local = head.HydraRelation.LocalHotWallet;
	const remote = head.HydraRelation.RemoteWallet;
	if (local.paymentSourceId !== paymentSourceId || remote.paymentSourceId !== paymentSourceId) return false;
	const buyerWallet = side === 'payment' ? request.BuyerWallet : request.SmartContractWallet;
	const sellerWallet = side === 'payment' ? request.SmartContractWallet : request.SellerWallet;
	if (!buyerWallet || !sellerWallet) return false;
	const localIsBuyer =
		buyerWallet.walletVkey === local.walletVkey &&
		buyerWallet.walletAddress === local.walletAddress &&
		sellerWallet.walletVkey === remote.walletVkey &&
		sellerWallet.walletAddress === remote.walletAddress;
	const localIsSeller =
		sellerWallet.walletVkey === local.walletVkey &&
		sellerWallet.walletAddress === local.walletAddress &&
		buyerWallet.walletVkey === remote.walletVkey &&
		buyerWallet.walletAddress === remote.walletAddress;
	return localIsBuyer || localIsSeller;
}

type PersistedEscrowState = {
	onChainState: OnChainState | null;
	resultHash: string | null;
	buyerCoolDownTime: bigint;
	sellerCoolDownTime: bigint;
	collateralReturnLovelace: bigint | null;
};

const UNRESOLVED_DISPUTED_WITHDRAWAL_REASON = 'cip8_redeemer_not_snapshot_bound';

function unresolvedDisputedWithdrawalNote(txId: string): string {
	return `Hydra disputed withdrawal ${txId} is confirmed, but its CIP-8 admin payload is not snapshot-bound. Automated actions are disabled; manual reconciliation is required.`;
}

function canonicalExpectedFunds(expectedFunds: Array<{ unit: string; amount: bigint }>): HydraAmount[] | null {
	return canonicalizeHydraAmounts(
		expectedFunds.map(({ unit, amount }) => ({
			unit,
			quantity: amount.toString(),
		})),
	);
}

function parsePersistedHydraValue(value: unknown): HydraAmount[] | null {
	if (!Array.isArray(value)) return null;
	const entries: unknown[] = value;
	const amounts: HydraAmount[] = [];
	for (const entry of entries) {
		if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) return null;
		if (!('unit' in entry) || !('quantity' in entry)) return null;
		const unit = entry.unit;
		const quantity = entry.quantity;
		if (typeof unit !== 'string' || typeof quantity !== 'string') return null;
		amounts.push({ unit, quantity });
	}
	const canonical = canonicalizeHydraAmounts(amounts);
	return canonical != null && canonical.length > 0 ? canonical : null;
}

function persistedHydraValue(amounts: readonly HydraAmount[]): Prisma.InputJsonValue {
	return amounts.map(({ unit, quantity }) => ({ unit, quantity }));
}

async function lockHydraMutationAdmission(tx: Prisma.TransactionClient, hydraHeadId: string): Promise<boolean> {
	const rows = await tx.$queryRaw<
		Array<{ isEnabled: boolean; initTxHash: string | null; reconciliationCompletedAt: Date | null }>
	>(Prisma.sql`
		SELECT "isEnabled", "initTxHash", "reconciliationCompletedAt"
		FROM "HydraHead"
		WHERE "id" = ${hydraHeadId}
		FOR SHARE
	`);
	const head = rows[0];
	return head?.isEnabled === true && head.initTxHash != null && head.reconciliationCompletedAt == null;
}

function validateCanonicalInitialLock(
	decoded: DecodedV1ContractDatum,
	expectedFunds: Array<{ unit: string; amount: bigint }>,
	outputAmounts: readonly HydraAmount[],
	confirmationTimeMs: bigint | number | null,
) {
	const canonicalExpected = canonicalExpectedFunds(expectedFunds);
	const canonicalOutput = canonicalizeHydraAmounts(outputAmounts);
	if (!canonicalExpected || !canonicalOutput) {
		return { valid: false, errorNote: 'Hydra value contains an invalid asset quantity.' };
	}
	return validateL2InitialLock(
		decoded,
		canonicalExpected.map(({ unit, quantity }) => ({ unit, amount: BigInt(quantity) })),
		canonicalOutput,
		confirmationTimeMs,
	);
}

function hasBodyBoundActor(evidence: HydraTransactionEvidence, actorVkey: string): boolean {
	return evidence.requiredSignerVkeys.includes(actorVkey) && evidence.signerVkeys.includes(actorVkey);
}

function continuationValueIsSafe(
	expectedFunds: Array<{ unit: string; amount: bigint }>,
	inputAmounts: readonly HydraAmount[],
	outputAmounts: Array<{ unit: string; quantity: string }>,
	collateralReturnLovelace: bigint,
): boolean {
	const canonicalExpected = canonicalExpectedFunds(expectedFunds);
	const canonicalInput = canonicalizeHydraAmounts(inputAmounts);
	const canonicalOutput = canonicalizeHydraAmounts(outputAmounts);
	if (
		!canonicalExpected ||
		!canonicalInput ||
		!canonicalOutput ||
		!hydraAmountListCovers(canonicalOutput, canonicalInput)
	) {
		return false;
	}
	const isToken = (unit: string) => unit !== '' && unit.toLowerCase() !== 'lovelace';
	if (
		canonicalExpected.filter((amount) => isToken(amount.unit)).length !==
		canonicalOutput.filter((amount) => isToken(amount.unit)).length
	) {
		return false;
	}
	return checkPaymentAmountsMatch(
		canonicalExpected.map(({ unit, quantity }) => ({ unit, amount: BigInt(quantity) })),
		canonicalOutput.map((amount) => ({ ...amount })),
		collateralReturnLovelace,
	);
}

/**
 * Independently authorize a continuing V2 escrow transition. Hydra 2.3 signs
 * the resulting TxOut multiset, but not the endpoint's witness/redeemer bytes.
 * Infer the action from the persisted prior state and signed new output, then
 * require the corresponding actor to have both committed itself in the body
 * and produced a valid signature over that exact body hash.
 */
function continuationHasAuthorizedActor(params: {
	request: PersistedEscrowState;
	decoded: DecodedV1ContractDatum;
	newState: OnChainState;
	expectedFunds: Array<{ unit: string; amount: bigint }>;
	inputAmounts: readonly HydraAmount[];
	outputAmounts: Array<{ unit: string; quantity: string }>;
	evidence: HydraTransactionEvidence;
	slotConfig: ReturnType<typeof resolveHydraL2EvidenceSlotConfig>;
	cooldownPeriodMs: number;
}): boolean {
	const {
		request,
		decoded,
		newState,
		expectedFunds,
		inputAmounts,
		outputAmounts,
		evidence,
		slotConfig,
		cooldownPeriodMs,
	} = params;
	const oldState = request.onChainState;
	const oldCollateral = request.collateralReturnLovelace;
	if (
		oldState == null ||
		oldState === OnChainState.FundsOrDatumInvalid ||
		oldCollateral == null ||
		oldCollateral !== decoded.collateralReturnLovelace ||
		!Number.isSafeInteger(cooldownPeriodMs) ||
		cooldownPeriodMs < 0 ||
		!continuationValueIsSafe(expectedFunds, inputAmounts, outputAmounts, oldCollateral)
	) {
		return false;
	}

	const lowerTime = hydraValidityLowerBoundTimeMs(evidence, slotConfig);
	const upperTime = hydraValidityUpperBoundTimeMs(evidence, slotConfig);
	// The validator globally requires a finite upper bound; every continuing
	// action also has a lower cooldown gate.
	if (lowerTime == null || upperTime == null || lowerTime > upperTime) return false;
	const startsAfter = (time: bigint) => lowerTime >= time;
	const endsBefore = (time: bigint) => upperTime < time;
	const cooldownFloor = upperTime + BigInt(cooldownPeriodMs);
	const resultIsUnchanged = decoded.resultHash === request.resultHash;

	const isSellerSubmitResult =
		hasBodyBoundActor(evidence, decoded.sellerVkey) &&
		decoded.resultHash != null &&
		startsAfter(request.sellerCoolDownTime) &&
		(endsBefore(decoded.resultTime) || (request.resultHash != null && endsBefore(decoded.externalDisputeUnlockTime))) &&
		decoded.sellerCooldownTime >= cooldownFloor &&
		decoded.buyerCooldownTime === 0n &&
		(((oldState === OnChainState.FundsLocked || oldState === OnChainState.ResultSubmitted) &&
			newState === OnChainState.ResultSubmitted) ||
			((oldState === OnChainState.RefundRequested || oldState === OnChainState.Disputed) &&
				newState === OnChainState.Disputed));

	const isBuyerRefundRequest =
		hasBodyBoundActor(evidence, decoded.buyerVkey) &&
		resultIsUnchanged &&
		startsAfter(request.buyerCoolDownTime) &&
		endsBefore(decoded.unlockTime) &&
		decoded.buyerCooldownTime >= cooldownFloor &&
		decoded.sellerCooldownTime === 0n &&
		((oldState === OnChainState.FundsLocked &&
			request.resultHash == null &&
			newState === OnChainState.RefundRequested) ||
			((oldState === OnChainState.ResultSubmitted || oldState === OnChainState.Disputed) &&
				request.resultHash != null &&
				newState === OnChainState.Disputed));

	const isBuyerWithdrawalAuthorization =
		oldState === OnChainState.Disputed &&
		newState === OnChainState.WithdrawAuthorized &&
		request.resultHash != null &&
		resultIsUnchanged &&
		hasBodyBoundActor(evidence, decoded.buyerVkey) &&
		startsAfter(request.buyerCoolDownTime) &&
		decoded.buyerCooldownTime >= cooldownFloor &&
		decoded.sellerCooldownTime === 0n;

	const isSellerRefundAuthorization =
		(oldState === OnChainState.FundsLocked ||
			oldState === OnChainState.ResultSubmitted ||
			oldState === OnChainState.RefundRequested ||
			oldState === OnChainState.Disputed) &&
		newState === OnChainState.RefundAuthorized &&
		decoded.resultHash == null &&
		hasBodyBoundActor(evidence, decoded.sellerVkey) &&
		startsAfter(request.sellerCoolDownTime) &&
		decoded.sellerCooldownTime >= cooldownFloor &&
		decoded.buyerCooldownTime === 0n;

	return isSellerSubmitResult || isBuyerRefundRequest || isBuyerWithdrawalAuthorization || isSellerRefundAuthorization;
}

function observationHasValidLineage(params: {
	hydraHeadId: string;
	txId: string;
	observedState: OnChainState;
	currentState: OnChainState | null;
	requestLayer: TransactionLayer;
	currentHydraUtxoTxHash: string | null;
	currentHydraUtxoOutputIndex: number | null;
	observedOutputReference: HydraOutputReference;
	currentTransaction: {
		txHash: string | null;
		intendedTxHash: string | null;
		status: TransactionStatus;
		layer: TransactionLayer;
		hydraHeadId: string | null;
	} | null;
	transactionHistory: Array<{ txHash: string | null }>;
	transactionEvidence: HydraTransactionEvidence | null;
	initialLockSignerVkey: string;
}): boolean {
	const {
		hydraHeadId,
		txId,
		observedState,
		currentState,
		requestLayer,
		currentHydraUtxoTxHash,
		currentHydraUtxoOutputIndex,
		observedOutputReference,
		currentTransaction,
		transactionHistory,
		transactionEvidence,
		initialLockSignerVkey,
	} = params;

	if (transactionHistory.some((history) => history.txHash === txId)) return false;
	const isSameAcceptedOutput =
		currentHydraUtxoTxHash === observedOutputReference.txHash &&
		currentHydraUtxoOutputIndex === observedOutputReference.outputIndex;

	// Initial locks create the script output without running a validator. Their
	// trust boundary is the full terms/amount/participant validation below plus
	// a real buyer payment-key witness on the creating transaction.
	if (observedState === OnChainState.FundsLocked && currentState == null) {
		const hasBuyerWitness = transactionEvidence?.signerVkeys.includes(initialLockSignerVkey) === true;
		return (
			hasBuyerWitness &&
			(currentTransaction == null ||
				((currentTransaction.txHash === txId || currentTransaction.intendedTxHash === txId) &&
					currentTransaction.layer === TransactionLayer.L2 &&
					currentTransaction.hydraHeadId === hydraHeadId))
		);
	}

	// A TxValid response can be followed by a DB failure before txHash is copied
	// from the pre-submit reservation. Permit that one exact pending intended hash;
	// the caller already bound evidence.txHash/output to txId, and the continuation
	// check below still requires the CBOR body to consume the persisted escrow UTxO.
	const hasExactIntendedPendingReservation =
		currentTransaction?.status === TransactionStatus.Pending &&
		currentTransaction.txHash == null &&
		currentTransaction.intendedTxHash === txId;
	if (
		requestLayer !== TransactionLayer.L2 ||
		currentTransaction?.layer !== TransactionLayer.L2 ||
		currentTransaction.hydraHeadId !== hydraHeadId ||
		(currentTransaction.txHash == null && !hasExactIntendedPendingReservation)
	) {
		return false;
	}

	// Invalid economic lineage stays parked for manual recovery. Re-reading its
	// same immutable output is harmless, but no later transition clears the taint.
	if (currentState === OnChainState.FundsOrDatumInvalid) return isSameAcceptedOutput;

	// A Cardano output is immutable. Re-observing the exact same reference may
	// only confirm the state already attached to it; any state change needs a new
	// CBOR-backed output whose transaction consumes the previous reference.
	if (isSameAcceptedOutput) return observedState === currentState;

	// A non-initial legacy row without an exact prior output cannot prove which
	// state/value was consumed. Keep it parked for explicit recovery.
	if (currentHydraUtxoTxHash == null || currentHydraUtxoOutputIndex == null || !transactionEvidence) return false;
	return transactionEvidence.inputs.some(
		(input) => input.txHash === currentHydraUtxoTxHash && input.outputIndex === currentHydraUtxoOutputIndex,
	);
}

function isLegacyPendingLineageCandidate(params: {
	hydraHeadId: string;
	txId: string;
	requestLayer: TransactionLayer;
	currentTransaction: {
		txHash: string | null;
		intendedTxHash: string | null;
		status: TransactionStatus;
		layer: TransactionLayer;
		hydraHeadId: string | null;
	} | null;
	transactionHistory: Array<{ txHash: string | null }>;
}): boolean {
	const { hydraHeadId, txId, requestLayer, currentTransaction, transactionHistory } = params;
	return (
		requestLayer === TransactionLayer.L2 &&
		currentTransaction?.status === TransactionStatus.Pending &&
		currentTransaction.layer === TransactionLayer.L2 &&
		currentTransaction.hydraHeadId === hydraHeadId &&
		currentTransaction.txHash !== txId &&
		currentTransaction.intendedTxHash !== txId &&
		transactionHistory.some((history) => history.txHash === txId)
	);
}

function canAdvanceLegacyHydraReference(params: {
	currentHydraUtxoTxHash: string | null;
	currentHydraUtxoOutputIndex: number | null;
	newOnChainState: OnChainState;
	decoded: DecodedV1ContractDatum;
	expectedFunds: Array<{ unit: string; amount: bigint }>;
	outputAmounts: Array<{ unit: string; quantity: string }>;
	transactionEvidence: HydraTransactionEvidence | null;
	confirmationTimeMs: number | null;
	signedValidityUpperBoundTimeMs: bigint | null;
}): boolean {
	const {
		currentHydraUtxoTxHash,
		currentHydraUtxoOutputIndex,
		newOnChainState,
		decoded,
		expectedFunds,
		outputAmounts,
		transactionEvidence,
		confirmationTimeMs,
		signedValidityUpperBoundTimeMs,
	} = params;
	if (currentHydraUtxoTxHash == null && currentHydraUtxoOutputIndex == null) {
		return (
			newOnChainState === OnChainState.FundsLocked &&
			confirmationTimeMs != null &&
			signedValidityUpperBoundTimeMs != null &&
			signedValidityUpperBoundTimeMs <= BigInt(decoded.payByTime) &&
			transactionEvidence?.signerVkeys.includes(decoded.buyerVkey) === true &&
			validateCanonicalInitialLock(decoded, expectedFunds, outputAmounts, confirmationTimeMs).valid
		);
	}
	// The persisted row reflects the result of this historical transition, not
	// its prior datum/cooldowns/value. Input lineage alone cannot reconstruct the
	// authorization proof, so advancing it would bypass the normal state machine.
	return false;
}

function resolveInitialLockState(
	newOnChainState: OnChainState,
	currentState: OnChainState | null,
	isSameAcceptedOutput: boolean,
	decoded: DecodedV1ContractDatum,
	expectedFunds: Array<{ unit: string; amount: bigint }>,
	outputAmounts: Array<{ unit: string; quantity: string }>,
	confirmationTimeMs: number | null,
	signedValidityUpperBoundTimeMs: bigint | null,
	logContext: { hydraHeadId: string; blockchainIdentifier: string; side: 'payment' | 'purchase' },
): OnChainState | null {
	if (newOnChainState !== OnChainState.FundsLocked) return newOnChainState;
	// The creation-time checks were already applied when this exact live output
	// first became current. A later snapshot (especially after restart) does not
	// carry historical confirmation time; revalidating would turn a valid lock
	// into FundsOrDatumInvalid. Preserve both valid and previously-invalid results.
	if (currentState != null && isSameAcceptedOutput) return currentState;
	// Hydra's API timestamp is transport metadata rather than part of the signed
	// transaction body. It may help accept a lock from an authenticated node, but
	// it must never irreversibly poison a request as "late". Missing, malformed,
	// or after-deadline time remains quarantined/retryable for operator recovery.
	if (
		confirmationTimeMs == null ||
		!Number.isSafeInteger(confirmationTimeMs) ||
		BigInt(confirmationTimeMs) > BigInt(decoded.payByTime)
	) {
		return null;
	}
	// SnapshotConfirmed timestamps are API metadata. A forged early timestamp
	// cannot authorize a late/unbounded initial lock: the immutable signed body
	// must independently end no later than the datum's payByTime.
	if (signedValidityUpperBoundTimeMs == null || signedValidityUpperBoundTimeMs > BigInt(decoded.payByTime)) {
		logger.warn('[HydraDatumSync] initial lock lacks a safe signed validity upper bound', {
			...logContext,
			signedValidityUpperBoundTimeMs: signedValidityUpperBoundTimeMs?.toString() ?? null,
			payByTime: decoded.payByTime.toString(),
		});
		return null;
	}
	const check = validateCanonicalInitialLock(decoded, expectedFunds, outputAmounts, confirmationTimeMs);
	if (check.valid) return OnChainState.FundsLocked;
	logger.warn('[HydraDatumSync] in-head initial lock failed validation -> FundsOrDatumInvalid', {
		...logContext,
		errorNote: check.errorNote,
	});
	return OnChainState.FundsOrDatumInvalid;
}

async function ensureObservedTransaction(
	tx: Prisma.TransactionClient,
	params: {
		hydraHeadId: string;
		txId: string;
		currentTransaction: {
			id: string;
			txHash: string | null;
			intendedTxHash: string | null;
			status: TransactionStatus;
			previousOnChainState: OnChainState | null;
			newOnChainState: OnChainState | null;
			BlocksWallet: { id: string } | null;
		} | null;
		previousState: OnChainState | null;
		newState: OnChainState;
	},
): Promise<string> {
	const { hydraHeadId, txId, currentTransaction, previousState, newState } = params;
	const canRepresentTransition = (candidate: {
		status: TransactionStatus;
		previousOnChainState: OnChainState | null;
		newOnChainState: OnChainState | null;
	}): boolean =>
		(candidate.previousOnChainState === previousState && candidate.newOnChainState === newState) ||
		(candidate.status === TransactionStatus.Pending &&
			candidate.previousOnChainState == null &&
			candidate.newOnChainState == null);
	if (
		(currentTransaction?.txHash === txId || currentTransaction?.intendedTxHash === txId) &&
		canRepresentTransition(currentTransaction)
	) {
		await tx.transaction.update({
			where: { id: currentTransaction.id },
			data: {
				txHash: txId,
				intendedTxHash: txId,
				status: TransactionStatus.Confirmed,
				layer: TransactionLayer.L2,
				HydraHead: { connect: { id: hydraHeadId } },
				previousOnChainState: previousState,
				newOnChainState: newState,
				...(currentTransaction.BlocksWallet ? { BlocksWallet: { disconnect: true } } : {}),
			},
		});
		return currentTransaction.id;
	}

	const existing = await tx.transaction.findFirst({
		where: {
			layer: TransactionLayer.L2,
			hydraHeadId,
			AND: [
				{ OR: [{ txHash: txId }, { txHash: null, intendedTxHash: txId }] },
				{
					OR: [
						{ previousOnChainState: previousState, newOnChainState: newState },
						{
							status: TransactionStatus.Pending,
							previousOnChainState: null,
							newOnChainState: null,
						},
					],
				},
			],
		},
		select: {
			id: true,
			status: true,
			previousOnChainState: true,
			newOnChainState: true,
			BlocksWallet: { select: { id: true } },
		},
	});
	if (existing && canRepresentTransition(existing)) {
		await tx.transaction.update({
			where: { id: existing.id },
			data: {
				txHash: txId,
				intendedTxHash: txId,
				status: TransactionStatus.Confirmed,
				layer: TransactionLayer.L2,
				HydraHead: { connect: { id: hydraHeadId } },
				previousOnChainState: previousState,
				newOnChainState: newState,
				...(existing.BlocksWallet ? { BlocksWallet: { disconnect: true } } : {}),
			},
		});
		if (existing.BlocksWallet) {
			await tx.hotWallet.update({
				where: { id: existing.BlocksWallet.id, deletedAt: null },
				data: { lockedAt: null },
			});
		}
		return existing.id;
	}

	const created = await tx.transaction.create({
		data: {
			txHash: txId,
			status: TransactionStatus.Confirmed,
			layer: TransactionLayer.L2,
			HydraHead: { connect: { id: hydraHeadId } },
			previousOnChainState: previousState,
			newOnChainState: newState,
		},
		select: { id: true },
	});
	return created.id;
}

async function releaseBlockedWallet(
	tx: Prisma.TransactionClient,
	currentTransaction: { id: string; BlocksWallet: { id: string } | null } | null,
): Promise<void> {
	if (!currentTransaction?.BlocksWallet) return;
	await tx.transaction.update({
		where: { id: currentTransaction.id },
		data: { BlocksWallet: { disconnect: true } },
	});
	await tx.hotWallet.update({
		where: { id: currentTransaction.BlocksWallet.id, deletedAt: null },
		data: { lockedAt: null },
	});
}

export async function applyDatumStateToLocalRequests(params: {
	hydraHeadId: string;
	txId: string;
	paymentSourceId: string;
	network: Network;
	decoded: DecodedV1ContractDatum;
	newOnChainState: OnChainState;
	outputAmounts: Array<{ unit: string; quantity: string }>;
	outputReference: HydraOutputReference;
	transactionEvidence: HydraTransactionEvidence | null;
	confirmationTimeMs: number | null;
	targetSide?: 'payment' | 'purchase';
	skipPendingCurrentTransaction?: boolean;
}): Promise<HydraDatumApplyOutcome> {
	const {
		hydraHeadId,
		txId,
		paymentSourceId,
		network,
		decoded,
		newOnChainState,
		outputAmounts,
		outputReference,
		transactionEvidence,
		confirmationTimeMs,
		targetSide,
		skipPendingCurrentTransaction = false,
	} = params;
	const evidenceSlotConfig = resolveHydraL2EvidenceSlotConfig(convertNetwork(network));
	const signedValidityUpperBoundTimeMs =
		transactionEvidence == null ? null : hydraValidityUpperBoundTimeMs(transactionEvidence, evidenceSlotConfig);
	const evidencedOutput = transactionEvidence?.outputs.find(
		(output) => output.outputIndex === outputReference.outputIndex,
	);
	if (
		transactionEvidence == null ||
		transactionEvidence.txHash !== txId ||
		outputReference.txHash !== txId ||
		evidencedOutput == null ||
		!hydraAmountListsEqual(evidencedOutput.amount, outputAmounts)
	) {
		logger.warn('[HydraDatumSync] missing or mismatched confirmed-CBOR output evidence', {
			hydraHeadId,
			txId,
			outputTxHash: outputReference.txHash,
			outputIndex: outputReference.outputIndex,
		});
		return 'retry';
	}
	const canonicalOutputAmounts = canonicalizeHydraAmounts(outputAmounts);
	if (!canonicalOutputAmounts || canonicalOutputAmounts.length === 0) return 'retry';
	const outputValueJson = persistedHydraValue(canonicalOutputAmounts);
	const blockchainIdentifier = decoded.blockchainIdentifier;
	const acceptedSides: Array<'payment' | 'purchase'> = [];
	let applyOutcome: HydraDatumApplyOutcome = 'retry';

	await prisma.$transaction(
		async (tx) => {
			if (!(await lockHydraMutationAdmission(tx, hydraHeadId))) return;
			const head = await tx.hydraHead.findUnique({
				where: { id: hydraHeadId },
				include: {
					HydraRelation: {
						include: {
							LocalHotWallet: { include: { PaymentSource: { select: { cooldownTime: true } } } },
							RemoteWallet: true,
						},
					},
				},
			});
			if (!head) return;

			const purchaseRequest = await tx.purchaseRequest.findUnique({
				where: { blockchainIdentifier, paymentSourceId },
				include: {
					NextAction: true,
					PaidFunds: true,
					CurrentTransaction: { include: { BlocksWallet: true } },
					TransactionHistory: { select: { txHash: true } },
					SellerWallet: true,
					SmartContractWallet: true,
				},
			});
			const paymentRequest = await tx.paymentRequest.findUnique({
				where: { blockchainIdentifier, paymentSourceId },
				include: {
					NextAction: true,
					RequestedFunds: true,
					CurrentTransaction: { include: { BlocksWallet: true } },
					TransactionHistory: { select: { txHash: true } },
					BuyerWallet: true,
					SmartContractWallet: true,
				},
			});
			const purchaseEffectiveForceLayer =
				purchaseRequest == null
					? null
					: resolveEffectiveForceLayer(purchaseRequest.forceLayer, purchaseRequest.paymentForceLayer);
			const purchaseHasHydraOwnership = purchaseRequest != null && hasHydraRequestOwnership(purchaseRequest);
			const paymentHasHydraOwnership = paymentRequest != null && hasHydraRequestOwnership(paymentRequest);
			const purchaseRoutingAllowsHydra =
				purchaseRequest == null ||
				purchaseHasHydraOwnership ||
				(purchaseRequest.onChainState == null &&
					purchaseRequest.CurrentTransaction == null &&
					purchaseEffectiveForceLayer !== TransactionLayer.L1 &&
					purchaseEffectiveForceLayer !== 'conflict');
			const paymentRoutingAllowsHydra =
				paymentRequest == null ||
				paymentHasHydraOwnership ||
				(paymentRequest.onChainState == null &&
					paymentRequest.CurrentTransaction == null &&
					paymentRequest.forceLayer !== TransactionLayer.L1);
			const hasTargetPurchase =
				(targetSide == null || targetSide === 'purchase') && purchaseRequest != null && purchaseRoutingAllowsHydra;
			const hasTargetPayment =
				(targetSide == null || targetSide === 'payment') && paymentRequest != null && paymentRoutingAllowsHydra;
			if (!hasTargetPurchase && !hasTargetPayment) {
				applyOutcome = 'irrelevant';
				return;
			}

			const purchaseLegacyCandidate =
				hasTargetPurchase &&
				purchaseRequest != null &&
				isLegacyPendingLineageCandidate({
					hydraHeadId,
					txId,
					requestLayer: purchaseRequest.layer,
					currentTransaction: purchaseRequest.CurrentTransaction,
					transactionHistory: purchaseRequest.TransactionHistory,
				});
			const paymentLegacyCandidate =
				hasTargetPayment &&
				paymentRequest != null &&
				isLegacyPendingLineageCandidate({
					hydraHeadId,
					txId,
					requestLayer: paymentRequest.layer,
					currentTransaction: paymentRequest.CurrentTransaction,
					transactionHistory: paymentRequest.TransactionHistory,
				});
			const shouldApplyPurchase =
				hasTargetPurchase &&
				purchaseRequest != null &&
				!purchaseLegacyCandidate &&
				purchaseRequest.NextAction.requestedAction !== PurchasingAction.None &&
				(!skipPendingCurrentTransaction || purchaseRequest.CurrentTransaction?.status !== TransactionStatus.Pending);
			const shouldApplyPayment =
				hasTargetPayment &&
				paymentRequest != null &&
				!paymentLegacyCandidate &&
				paymentRequest.NextAction.requestedAction !== PaymentAction.None &&
				(!skipPendingCurrentTransaction || paymentRequest.CurrentTransaction?.status !== TransactionStatus.Pending);
			const recoverablePurchaseWallet =
				head.HydraRelation.LocalHotWallet.paymentSourceId === paymentSourceId &&
				head.HydraRelation.LocalHotWallet.type === HotWalletType.Purchasing &&
				head.HydraRelation.LocalHotWallet.walletVkey === decoded.buyerVkey &&
				head.HydraRelation.LocalHotWallet.walletAddress === decoded.buyerAddress
					? head.HydraRelation.LocalHotWallet
					: null;

			const purchaseParticipantsAreValid =
				purchaseRequest != null && headParticipantsMatch(decoded, 'purchase', head, paymentSourceId);
			const purchaseDatumIsValid =
				purchaseRequest != null &&
				datumMatchesRequest(decoded, {
					inputHash: purchaseRequest.inputHash,
					submitResultTime: purchaseRequest.submitResultTime,
					unlockTime: purchaseRequest.unlockTime,
					externalDisputeUnlockTime: purchaseRequest.externalDisputeUnlockTime,
					payByTime: purchaseRequest.payByTime,
					buyerAddress:
						purchaseRequest.SmartContractWallet?.walletAddress ?? recoverablePurchaseWallet?.walletAddress ?? null,
					sellerAddress: purchaseRequest.SellerWallet?.walletAddress ?? null,
					buyerReturnAddress: purchaseRequest.buyerReturnAddress,
					sellerReturnAddress: purchaseRequest.sellerReturnAddress,
					buyerVkey: purchaseRequest.SmartContractWallet?.walletVkey ?? recoverablePurchaseWallet?.walletVkey ?? null,
					sellerVkey: purchaseRequest.SellerWallet?.walletVkey ?? null,
				});
			const purchaseLineageIsValid =
				purchaseRequest != null &&
				observationHasValidLineage({
					hydraHeadId,
					txId,
					observedState: newOnChainState,
					currentState: purchaseRequest.onChainState,
					requestLayer: purchaseRequest.layer,
					currentHydraUtxoTxHash: purchaseRequest.currentHydraUtxoTxHash,
					currentHydraUtxoOutputIndex: purchaseRequest.currentHydraUtxoOutputIndex,
					observedOutputReference: outputReference,
					currentTransaction: purchaseRequest.CurrentTransaction,
					transactionHistory: purchaseRequest.TransactionHistory,
					transactionEvidence,
					initialLockSignerVkey: decoded.buyerVkey,
				});
			const purchaseIsSameAcceptedOutput =
				purchaseRequest != null &&
				purchaseRequest.currentHydraUtxoTxHash === outputReference.txHash &&
				purchaseRequest.currentHydraUtxoOutputIndex === outputReference.outputIndex;
			const purchasePersistedInputValue =
				purchaseRequest == null ? null : parsePersistedHydraValue(purchaseRequest.currentHydraUtxoValue);
			const purchaseActionIsAuthorized =
				purchaseRequest != null &&
				(purchaseIsSameAcceptedOutput
					? purchaseRequest.onChainState === newOnChainState &&
						(purchaseRequest.currentHydraUtxoValue == null ||
							(purchasePersistedInputValue != null &&
								hydraAmountListsEqual(purchasePersistedInputValue, canonicalOutputAmounts)))
					: purchaseRequest.onChainState == null
						? newOnChainState === OnChainState.FundsLocked && purchaseRequest.currentHydraUtxoValue == null
						: transactionEvidence != null &&
							purchasePersistedInputValue != null &&
							continuationHasAuthorizedActor({
								request: purchaseRequest,
								decoded,
								newState: newOnChainState,
								expectedFunds: purchaseRequest.PaidFunds,
								inputAmounts: purchasePersistedInputValue,
								outputAmounts: canonicalOutputAmounts,
								evidence: transactionEvidence,
								slotConfig: evidenceSlotConfig,
								cooldownPeriodMs: head.HydraRelation.LocalHotWallet.PaymentSource.cooldownTime,
							}));
			const purchaseIsTrusted =
				shouldApplyPurchase &&
				purchaseParticipantsAreValid &&
				purchaseDatumIsValid &&
				purchaseLineageIsValid &&
				purchaseActionIsAuthorized;
			const paymentParticipantsAreValid =
				paymentRequest != null && headParticipantsMatch(decoded, 'payment', head, paymentSourceId);
			const paymentDatumIsValid =
				paymentRequest != null &&
				datumMatchesRequest(decoded, {
					inputHash: paymentRequest.inputHash,
					submitResultTime: paymentRequest.submitResultTime,
					unlockTime: paymentRequest.unlockTime,
					externalDisputeUnlockTime: paymentRequest.externalDisputeUnlockTime,
					payByTime: paymentRequest.payByTime,
					buyerAddress: paymentRequest.BuyerWallet?.walletAddress ?? null,
					sellerAddress: paymentRequest.SmartContractWallet?.walletAddress ?? null,
					buyerReturnAddress:
						paymentRequest.onChainState == null && paymentRequest.buyerReturnAddress == null
							? undefined
							: paymentRequest.buyerReturnAddress,
					sellerReturnAddress: paymentRequest.sellerReturnAddress,
					buyerVkey: paymentRequest.BuyerWallet?.walletVkey ?? null,
					sellerVkey: paymentRequest.SmartContractWallet?.walletVkey ?? null,
				});
			let hasLegacyBackfill = false;
			let hasLegacyBackfillRetry = false;
			if (purchaseLegacyCandidate && purchaseRequest) {
				const canAdvance =
					purchaseParticipantsAreValid &&
					purchaseDatumIsValid &&
					canAdvanceLegacyHydraReference({
						currentHydraUtxoTxHash: purchaseRequest.currentHydraUtxoTxHash,
						currentHydraUtxoOutputIndex: purchaseRequest.currentHydraUtxoOutputIndex,
						newOnChainState,
						decoded,
						expectedFunds: purchaseRequest.PaidFunds,
						outputAmounts,
						transactionEvidence,
						confirmationTimeMs,
						signedValidityUpperBoundTimeMs,
					});
				if (canAdvance) {
					await tx.purchaseRequest.update({
						where: { id: purchaseRequest.id },
						data: {
							currentHydraUtxoTxHash: outputReference.txHash,
							currentHydraUtxoOutputIndex: outputReference.outputIndex,
							currentHydraUtxoValue: outputValueJson,
							unresolvedHydraTerminalTxHash: null,
							unresolvedHydraTerminalReason: null,
						},
					});
					hasLegacyBackfill = true;
				} else {
					hasLegacyBackfillRetry = true;
				}
			}
			if (paymentLegacyCandidate && paymentRequest) {
				const canAdvance =
					paymentParticipantsAreValid &&
					paymentDatumIsValid &&
					canAdvanceLegacyHydraReference({
						currentHydraUtxoTxHash: paymentRequest.currentHydraUtxoTxHash,
						currentHydraUtxoOutputIndex: paymentRequest.currentHydraUtxoOutputIndex,
						newOnChainState,
						decoded,
						expectedFunds: paymentRequest.RequestedFunds,
						outputAmounts,
						transactionEvidence,
						confirmationTimeMs,
						signedValidityUpperBoundTimeMs,
					});
				if (canAdvance) {
					await tx.paymentRequest.update({
						where: { id: paymentRequest.id },
						data: {
							currentHydraUtxoTxHash: outputReference.txHash,
							currentHydraUtxoOutputIndex: outputReference.outputIndex,
							currentHydraUtxoValue: outputValueJson,
							unresolvedHydraTerminalTxHash: null,
							unresolvedHydraTerminalReason: null,
						},
					});
					hasLegacyBackfill = true;
				} else {
					hasLegacyBackfillRetry = true;
				}
			}
			const paymentLineageIsValid =
				paymentRequest != null &&
				observationHasValidLineage({
					hydraHeadId,
					txId,
					observedState: newOnChainState,
					currentState: paymentRequest.onChainState,
					requestLayer: paymentRequest.layer,
					currentHydraUtxoTxHash: paymentRequest.currentHydraUtxoTxHash,
					currentHydraUtxoOutputIndex: paymentRequest.currentHydraUtxoOutputIndex,
					observedOutputReference: outputReference,
					currentTransaction: paymentRequest.CurrentTransaction,
					transactionHistory: paymentRequest.TransactionHistory,
					transactionEvidence,
					initialLockSignerVkey: decoded.buyerVkey,
				});
			const paymentIsSameAcceptedOutput =
				paymentRequest != null &&
				paymentRequest.currentHydraUtxoTxHash === outputReference.txHash &&
				paymentRequest.currentHydraUtxoOutputIndex === outputReference.outputIndex;
			const paymentPersistedInputValue =
				paymentRequest == null ? null : parsePersistedHydraValue(paymentRequest.currentHydraUtxoValue);
			const paymentActionIsAuthorized =
				paymentRequest != null &&
				(paymentIsSameAcceptedOutput
					? paymentRequest.onChainState === newOnChainState &&
						(paymentRequest.currentHydraUtxoValue == null ||
							(paymentPersistedInputValue != null &&
								hydraAmountListsEqual(paymentPersistedInputValue, canonicalOutputAmounts)))
					: paymentRequest.onChainState == null
						? newOnChainState === OnChainState.FundsLocked && paymentRequest.currentHydraUtxoValue == null
						: transactionEvidence != null &&
							paymentPersistedInputValue != null &&
							continuationHasAuthorizedActor({
								request: paymentRequest,
								decoded,
								newState: newOnChainState,
								expectedFunds: paymentRequest.RequestedFunds,
								inputAmounts: paymentPersistedInputValue,
								outputAmounts: canonicalOutputAmounts,
								evidence: transactionEvidence,
								slotConfig: evidenceSlotConfig,
								cooldownPeriodMs: head.HydraRelation.LocalHotWallet.PaymentSource.cooldownTime,
							}));
			const paymentIsTrusted =
				shouldApplyPayment &&
				paymentParticipantsAreValid &&
				paymentDatumIsValid &&
				paymentLineageIsValid &&
				paymentActionIsAuthorized;

			if (!shouldApplyPurchase && !shouldApplyPayment) {
				if (hasLegacyBackfillRetry) {
					applyOutcome = 'retry';
					return;
				}
				if (hasLegacyBackfill) {
					applyOutcome = 'applied';
					return;
				}
				const hasPendingTarget =
					(hasTargetPurchase && purchaseRequest?.CurrentTransaction?.status === TransactionStatus.Pending) ||
					(hasTargetPayment && paymentRequest?.CurrentTransaction?.status === TransactionStatus.Pending);
				applyOutcome = hasPendingTarget ? 'retry' : 'irrelevant';
				return;
			}
			const purchaseIsPermanentReject =
				shouldApplyPurchase &&
				purchaseRequest != null &&
				(!purchaseParticipantsAreValid ||
					!purchaseDatumIsValid ||
					purchaseRequest.TransactionHistory.some((history) => history.txHash === txId) ||
					(purchaseRequest.onChainState === OnChainState.FundsOrDatumInvalid && !purchaseIsSameAcceptedOutput) ||
					(newOnChainState === OnChainState.FundsLocked &&
						purchaseRequest.onChainState == null &&
						transactionEvidence != null &&
						!transactionEvidence.signerVkeys.includes(decoded.buyerVkey)));
			const paymentIsPermanentReject =
				shouldApplyPayment &&
				paymentRequest != null &&
				(!paymentParticipantsAreValid ||
					!paymentDatumIsValid ||
					paymentRequest.TransactionHistory.some((history) => history.txHash === txId) ||
					(paymentRequest.onChainState === OnChainState.FundsOrDatumInvalid && !paymentIsSameAcceptedOutput) ||
					(newOnChainState === OnChainState.FundsLocked &&
						paymentRequest.onChainState == null &&
						transactionEvidence != null &&
						!transactionEvidence.signerVkeys.includes(decoded.buyerVkey)));
			// Per-side gating: only a TRANSIENTLY-unproven side (not yet trusted but not
			// permanently rejected either) blocks the tx with 'retry'. A PERMANENTLY
			// rejected side can never become trusted, so it is excluded from application
			// instead of blocking — otherwise one diverged row (e.g. a row created after
			// this tx already applied to the other side) would wedge the head's entire
			// ordered replay forever: 'retry' pauses the causal suffix and the cursor
			// never advances.
			const purchaseIsBlocking = shouldApplyPurchase && !purchaseIsTrusted && !purchaseIsPermanentReject;
			const paymentIsBlocking = shouldApplyPayment && !paymentIsTrusted && !paymentIsPermanentReject;
			if (purchaseIsBlocking || paymentIsBlocking) {
				return; // default outcome: 'retry' (fail-closed for unproven sides)
			}
			if (!purchaseIsTrusted && !paymentIsTrusted) {
				applyOutcome = 'irrelevant';
				return;
			}
			if ((shouldApplyPurchase && purchaseIsPermanentReject) || (shouldApplyPayment && paymentIsPermanentReject)) {
				logger.warn('[HydraDatumSync] one side permanently rejected; applying the other side only', {
					hydraHeadId,
					blockchainIdentifier,
					txId,
					purchaseIsPermanentReject,
					paymentIsPermanentReject,
				});
			}
			const purchaseEffectiveState =
				purchaseIsTrusted && purchaseRequest
					? resolveInitialLockState(
							newOnChainState,
							purchaseRequest.onChainState,
							purchaseIsSameAcceptedOutput,
							decoded,
							purchaseRequest.PaidFunds,
							canonicalOutputAmounts,
							confirmationTimeMs,
							signedValidityUpperBoundTimeMs,
							{ hydraHeadId, blockchainIdentifier, side: 'purchase' },
						)
					: null;
			const paymentEffectiveState =
				paymentIsTrusted && paymentRequest
					? resolveInitialLockState(
							newOnChainState,
							paymentRequest.onChainState,
							paymentIsSameAcceptedOutput,
							decoded,
							paymentRequest.RequestedFunds,
							canonicalOutputAmounts,
							confirmationTimeMs,
							signedValidityUpperBoundTimeMs,
							{ hydraHeadId, blockchainIdentifier, side: 'payment' },
						)
					: null;
			if (
				(purchaseIsTrusted && purchaseEffectiveState == null) ||
				(paymentIsTrusted && paymentEffectiveState == null)
			) {
				return;
			}

			if (purchaseIsTrusted && purchaseRequest) {
				const isSameAcceptedOutput = purchaseIsSameAcceptedOutput;
				const effectiveState = purchaseEffectiveState;
				if (effectiveState == null) return;
				const alreadyApplied =
					purchaseRequest.onChainState === effectiveState &&
					purchaseRequest.CurrentTransaction?.txHash === txId &&
					purchaseRequest.CurrentTransaction.status === TransactionStatus.Confirmed;
				if (alreadyApplied) {
					if (!isSameAcceptedOutput || purchaseRequest.currentHydraUtxoValue == null) {
						await tx.purchaseRequest.update({
							where: { id: purchaseRequest.id },
							data: {
								currentHydraUtxoTxHash: outputReference.txHash,
								currentHydraUtxoOutputIndex: outputReference.outputIndex,
								currentHydraUtxoValue: outputValueJson,
								unresolvedHydraTerminalTxHash: null,
								unresolvedHydraTerminalReason: null,
							},
						});
					}
				} else {
					const observedTransactionId = await ensureObservedTransaction(tx, {
						hydraHeadId,
						txId,
						currentTransaction: purchaseRequest.CurrentTransaction,
						previousState: purchaseRequest.onChainState,
						newState: effectiveState,
					});
					const newAction = convertNewPurchasingActionAndError(
						purchaseRequest.NextAction.requestedAction,
						effectiveState,
					);
					await tx.purchaseRequest.update({
						where: { id: purchaseRequest.id },
						data: {
							layer: TransactionLayer.L2,
							currentHydraUtxoTxHash: outputReference.txHash,
							currentHydraUtxoOutputIndex: outputReference.outputIndex,
							currentHydraUtxoValue: outputValueJson,
							unresolvedHydraTerminalTxHash: null,
							unresolvedHydraTerminalReason: null,
							onChainState: effectiveState,
							resultHash: decoded.resultHash,
							collateralReturnLovelace: decoded.collateralReturnLovelace,
							buyerCoolDownTime: decoded.buyerCooldownTime,
							sellerCoolDownTime: decoded.sellerCooldownTime,
							buyerReturnAddress: decoded.buyerReturnAddress ?? null,
							sellerReturnAddress: decoded.sellerReturnAddress ?? null,
							...(purchaseRequest.SmartContractWallet == null && recoverablePurchaseWallet
								? { SmartContractWallet: { connect: { id: recoverablePurchaseWallet.id } } }
								: {}),
							ActionHistory: { connect: { id: purchaseRequest.nextActionId } },
							NextAction: {
								create: {
									requestedAction: newAction.action,
									errorNote: newAction.errorNote,
									errorType: newAction.errorType,
								},
							},
							TransactionHistory:
								purchaseRequest.currentTransactionId && purchaseRequest.currentTransactionId !== observedTransactionId
									? { connect: { id: purchaseRequest.currentTransactionId } }
									: undefined,
							CurrentTransaction: { connect: { id: observedTransactionId } },
						},
					});
					await releaseBlockedWallet(tx, purchaseRequest.CurrentTransaction);
				}
				acceptedSides.push('purchase');
			}

			if (paymentIsTrusted && paymentRequest) {
				const isSameAcceptedOutput = paymentIsSameAcceptedOutput;
				const effectiveState = paymentEffectiveState;
				if (effectiveState == null) return;
				const alreadyApplied =
					paymentRequest.onChainState === effectiveState &&
					paymentRequest.CurrentTransaction?.txHash === txId &&
					paymentRequest.CurrentTransaction.status === TransactionStatus.Confirmed;
				if (alreadyApplied) {
					if (!isSameAcceptedOutput || paymentRequest.currentHydraUtxoValue == null) {
						await tx.paymentRequest.update({
							where: { id: paymentRequest.id },
							data: {
								currentHydraUtxoTxHash: outputReference.txHash,
								currentHydraUtxoOutputIndex: outputReference.outputIndex,
								currentHydraUtxoValue: outputValueJson,
								unresolvedHydraTerminalTxHash: null,
								unresolvedHydraTerminalReason: null,
							},
						});
					}
				} else {
					const observedTransactionId = await ensureObservedTransaction(tx, {
						hydraHeadId,
						txId,
						currentTransaction: paymentRequest.CurrentTransaction,
						previousState: paymentRequest.onChainState,
						newState: effectiveState,
					});
					const newAction = convertNewPaymentActionAndError(paymentRequest.NextAction.requestedAction, effectiveState);
					await tx.paymentRequest.update({
						where: { id: paymentRequest.id },
						data: {
							layer: TransactionLayer.L2,
							currentHydraUtxoTxHash: outputReference.txHash,
							currentHydraUtxoOutputIndex: outputReference.outputIndex,
							currentHydraUtxoValue: outputValueJson,
							unresolvedHydraTerminalTxHash: null,
							unresolvedHydraTerminalReason: null,
							onChainState: effectiveState,
							resultHash: decoded.resultHash,
							collateralReturnLovelace: decoded.collateralReturnLovelace,
							buyerCoolDownTime: decoded.buyerCooldownTime,
							sellerCoolDownTime: decoded.sellerCooldownTime,
							buyerReturnAddress: decoded.buyerReturnAddress ?? null,
							sellerReturnAddress: decoded.sellerReturnAddress ?? null,
							ActionHistory: { connect: { id: paymentRequest.nextActionId } },
							NextAction: {
								create: {
									requestedAction: newAction.action,
									errorNote: newAction.errorNote,
									errorType: newAction.errorType,
								},
							},
							BuyerWallet: {
								connectOrCreate: {
									where: {
										paymentSourceId_walletVkey_walletAddress_type: {
											paymentSourceId,
											walletVkey: decoded.buyerVkey,
											walletAddress: decoded.buyerAddress,
											type: WalletType.Buyer,
										},
									},
									create: {
										walletVkey: decoded.buyerVkey,
										walletAddress: decoded.buyerAddress,
										type: WalletType.Buyer,
										PaymentSource: { connect: { id: paymentSourceId } },
									},
								},
							},
							TransactionHistory:
								paymentRequest.currentTransactionId && paymentRequest.currentTransactionId !== observedTransactionId
									? { connect: { id: paymentRequest.currentTransactionId } }
									: undefined,
							CurrentTransaction: { connect: { id: observedTransactionId } },
						},
					});
					await releaseBlockedWallet(tx, paymentRequest.CurrentTransaction);
				}
				acceptedSides.push('payment');
			}
			applyOutcome = hasLegacyBackfillRetry ? 'retry' : 'applied';
		},
		{
			isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
			timeout: CONSTANTS.TRANSACTION_WAIT.SERIALIZABLE,
			maxWait: CONSTANTS.TRANSACTION_WAIT.SERIALIZABLE,
		},
	);

	if (acceptedSides.length === 0) {
		logger.warn('[HydraDatumSync] rejected unproven or mismatched datum observation', {
			hydraHeadId,
			blockchainIdentifier,
			txId,
		});
	}
	return applyOutcome;
}

function outputReferenceDatum(txHash: string, outputIndex: number): string {
	return Data.to(new Constr(0, [txHash, BigInt(outputIndex)])).toLowerCase();
}

function sumTaggedOutputs(
	evidence: HydraTransactionEvidence,
	address: string,
	input: { txHash: string; outputIndex: number },
): Map<string, bigint> {
	const expectedDatum = outputReferenceDatum(input.txHash, input.outputIndex);
	const amounts = new Map<string, bigint>();
	for (const output of evidence.outputs) {
		if (output.address !== address || output.plutusData?.toLowerCase() !== expectedDatum) continue;
		for (const amount of output.amount) {
			const unit =
				amount.unit === '' || amount.unit.toLowerCase() === 'lovelace' ? 'lovelace' : amount.unit.toLowerCase();
			amounts.set(unit, (amounts.get(unit) ?? 0n) + BigInt(amount.quantity));
		}
	}
	return amounts;
}

function taggedValueCovers(actual: Map<string, bigint>, required: readonly HydraAmount[]): boolean {
	return hydraAmountListCovers(
		[...actual].map(([unit, quantity]) => ({ unit, quantity: quantity.toString() })),
		required,
	);
}

function valueAfterCollateral(inputValue: readonly HydraAmount[], collateral: bigint): HydraAmount[] | null {
	if (collateral < 0n) return null;
	const canonical = canonicalizeHydraAmounts(inputValue);
	if (!canonical) return null;
	const lovelace = canonical.find(({ unit }) => unit === 'lovelace');
	if (collateral > BigInt(lovelace?.quantity ?? '0')) return null;
	return canonical
		.map((amount) =>
			amount.unit === 'lovelace' ? { ...amount, quantity: (BigInt(amount.quantity) - collateral).toString() } : amount,
		)
		.filter(({ quantity }) => quantity !== '0');
}

function authorizedTerminalState(params: {
	request: PersistedEscrowState & {
		buyerReturnAddress: string | null;
		sellerReturnAddress: string | null;
	};
	buyer: { walletVkey: string; walletAddress: string };
	seller: { walletVkey: string; walletAddress: string };
	inputValue: readonly HydraAmount[];
	input: { txHash: string; outputIndex: number };
	evidence: HydraTransactionEvidence;
	slotConfig: ReturnType<typeof resolveHydraL2EvidenceSlotConfig>;
	resultTime: bigint;
	unlockTime: bigint;
}): OnChainState | null {
	const { request, buyer, seller, inputValue, input, evidence, slotConfig, resultTime, unlockTime } = params;
	const collateral = request.collateralReturnLovelace;
	if (collateral == null || collateral < 0n) return null;
	const sellerRequiredValue = valueAfterCollateral(inputValue, collateral);
	if (!sellerRequiredValue) return null;
	const lowerTime = hydraValidityLowerBoundTimeMs(evidence, slotConfig);
	const upperTime = hydraValidityUpperBoundTimeMs(evidence, slotConfig);
	if (upperTime == null || (lowerTime != null && lowerTime > upperTime)) return null;

	if (
		(request.onChainState === OnChainState.ResultSubmitted ||
			request.onChainState === OnChainState.WithdrawAuthorized) &&
		request.resultHash != null &&
		hasBodyBoundActor(evidence, seller.walletVkey) &&
		(request.onChainState === OnChainState.WithdrawAuthorized || (lowerTime != null && lowerTime >= unlockTime))
	) {
		const buyerTarget = request.buyerReturnAddress ?? buyer.walletAddress;
		const buyerPayout = sumTaggedOutputs(evidence, buyerTarget, input);
		if (request.sellerReturnAddress != null) {
			const sellerPayout = sumTaggedOutputs(evidence, request.sellerReturnAddress, input);
			if (!taggedValueCovers(sellerPayout, sellerRequiredValue)) return null;
		}
		if ((buyerPayout.get('lovelace') ?? 0n) < collateral) return null;
		return OnChainState.Withdrawn;
	}

	if (
		(request.onChainState === OnChainState.FundsLocked ||
			request.onChainState === OnChainState.RefundRequested ||
			request.onChainState === OnChainState.RefundAuthorized) &&
		request.resultHash == null &&
		hasBodyBoundActor(evidence, buyer.walletVkey) &&
		(request.onChainState === OnChainState.RefundAuthorized || (lowerTime != null && lowerTime >= resultTime))
	) {
		// With no return address, the V2 contract intentionally lets the buyer
		// choose any destination in the body they signed. When one is pinned, the
		// full exact input value must be carried by own-ref-tagged outputs.
		if (request.buyerReturnAddress != null) {
			const buyerPayout = sumTaggedOutputs(evidence, request.buyerReturnAddress, input);
			if (!taggedValueCovers(buyerPayout, inputValue)) return null;
		}
		return OnChainState.RefundWithdrawn;
	}

	// WithdrawDisputed uses CIP-8 signatures embedded in the redeemer rather
	// than body VKey witnesses. Hydra 2.3 does not sign those witness bytes, so
	// fail closed until the admin payload is independently verified.
	return null;
}

function isUnresolvedDisputedWithdrawal(params: {
	request: { onChainState: OnChainState | null; resultHash: string | null; externalDisputeUnlockTime: bigint };
	input: { txHash: string; outputIndex: number };
	evidence: HydraTransactionEvidence;
	slotConfig: ReturnType<typeof resolveHydraL2EvidenceSlotConfig>;
}): boolean {
	const { request, input, evidence, slotConfig } = params;
	if (request.onChainState !== OnChainState.Disputed || request.resultHash == null) return false;
	const lowerTime = hydraValidityLowerBoundTimeMs(evidence, slotConfig);
	const upperTime = hydraValidityUpperBoundTimeMs(evidence, slotConfig);
	return (
		lowerTime != null &&
		upperTime != null &&
		lowerTime <= upperTime &&
		lowerTime >= request.externalDisputeUnlockTime &&
		evidence.spends.some(
			(spend) =>
				spend.txHash === input.txHash && spend.outputIndex === input.outputIndex && spend.redeemerVersion === 4,
		)
	);
}

/** Reconcile confirmed terminal spends, which have no continuation output. */
export async function applyTerminalHydraSpends(params: {
	hydraHeadId: string;
	txId: string;
	paymentSourceId: string;
	transactionEvidence: HydraTransactionEvidence;
}): Promise<HydraDatumApplyOutcome> {
	const { hydraHeadId, txId, paymentSourceId, transactionEvidence } = params;
	if (transactionEvidence.txHash !== txId) return 'retry';
	// Endpoint-supplied redeemers are witness metadata and are not covered by a
	// Hydra 2.3 snapshot signature. Candidate terminal actions therefore start
	// from body inputs and are authorized below from prior state + actor proof.
	const candidateInputs = transactionEvidence.inputs;
	const inputHashes = [...new Set(candidateInputs.map((input) => input.txHash))];
	if (inputHashes.length === 0) return 'irrelevant';
	let hasCandidate = false;
	let hasApplied = false;
	let hasEvidenceFailure = false;
	let hasUnresolvedDisputedWithdrawal = false;
	let isAdmissionDenied = false;

	await prisma.$transaction(
		async (tx) => {
			if (!(await lockHydraMutationAdmission(tx, hydraHeadId))) {
				isAdmissionDenied = true;
				return;
			}
			const head = await tx.hydraHead.findUnique({
				where: { id: hydraHeadId },
				include: {
					HydraRelation: {
						include: {
							LocalHotWallet: { include: { PaymentSource: true } },
							RemoteWallet: true,
						},
					},
				},
			});
			if (!head) return;
			const source = head.HydraRelation.LocalHotWallet.PaymentSource;
			if (source.id !== paymentSourceId) return;
			const continuationReferenceSignatures = new Set<string>();
			for (const output of transactionEvidence.outputs) {
				if (output.address !== source.smartContractAddress || output.plutusData == null) continue;
				try {
					const decoded = decodeV2ContractDatum(
						deserializeDatum(output.plutusData),
						convertNetwork(source.network),
						source.smartContractAddress,
					);
					if (decoded) continuationReferenceSignatures.add(decoded.referenceSignature);
				} catch {
					// Script-address dust is permissionless. Candidate terminal spends
					// are independently selected by exact persisted input references and
					// authorized below, so unrelated malformed outputs are irrelevant.
					continue;
				}
			}
			const slotConfig = resolveHydraL2EvidenceSlotConfig(convertNetwork(source.network));

			const paymentRequests = await tx.paymentRequest.findMany({
				where: {
					paymentSourceId,
					layer: TransactionLayer.L2,
					currentHydraUtxoTxHash: { in: inputHashes },
				},
				include: {
					NextAction: true,
					CurrentTransaction: { include: { BlocksWallet: true } },
					TransactionHistory: { select: { txHash: true } },
					RequestedFunds: true,
					BuyerWallet: true,
					SmartContractWallet: true,
				},
			});
			for (const request of paymentRequests) {
				const requestIdentifier = decodeBlockchainIdentifier(request.blockchainIdentifier);
				const spend = candidateInputs.find(
					(candidate) =>
						candidate.txHash === request.currentHydraUtxoTxHash &&
						candidate.outputIndex === request.currentHydraUtxoOutputIndex,
				);
				if (!spend) continue;
				hasCandidate = true;
				if (
					requestIdentifier == null ||
					continuationReferenceSignatures.has(requestIdentifier.signature) ||
					request.currentHydraUtxoTxHash == null ||
					request.currentHydraUtxoOutputIndex == null ||
					request.TransactionHistory.some((history) => history.txHash === txId) ||
					!requestParticipantsMatch('payment', request, head, paymentSourceId)
				) {
					continue;
				}
				if (!request.BuyerWallet || !request.SmartContractWallet) continue;
				const isUnresolvedDisputedSpend = isUnresolvedDisputedWithdrawal({
					request,
					input: spend,
					evidence: transactionEvidence,
					slotConfig,
				});
				if (isUnresolvedDisputedSpend) {
					const matchingCurrentTransaction =
						request.CurrentTransaction?.layer === TransactionLayer.L2 &&
						request.CurrentTransaction.hydraHeadId === hydraHeadId &&
						(request.CurrentTransaction.txHash === txId || request.CurrentTransaction.intendedTxHash === txId)
							? request.CurrentTransaction
							: null;
					const observedTransactionId = await ensureObservedTransaction(tx, {
						hydraHeadId,
						txId,
						currentTransaction: matchingCurrentTransaction,
						previousState: request.onChainState,
						newState: OnChainState.Disputed,
					});
					if (matchingCurrentTransaction) await releaseBlockedWallet(tx, matchingCurrentTransaction);
					const conflictingPendingTransaction =
						request.CurrentTransaction?.id !== observedTransactionId &&
						request.CurrentTransaction?.status === TransactionStatus.Pending &&
						request.CurrentTransaction.layer === TransactionLayer.L2 &&
						request.CurrentTransaction.hydraHeadId === hydraHeadId
							? request.CurrentTransaction
							: null;
					if (conflictingPendingTransaction) {
						await tx.transaction.update({
							where: { id: conflictingPendingTransaction.id },
							data: { status: TransactionStatus.RolledBack },
						});
						await releaseBlockedWallet(tx, conflictingPendingTransaction);
					}
					const isAlreadyParked =
						request.unresolvedHydraTerminalTxHash === txId &&
						request.unresolvedHydraTerminalReason === UNRESOLVED_DISPUTED_WITHDRAWAL_REASON &&
						request.NextAction.requestedAction === PaymentAction.None;
					await tx.paymentRequest.update({
						where: { id: request.id },
						data: {
							unresolvedHydraTerminalTxHash: txId,
							unresolvedHydraTerminalReason: UNRESOLVED_DISPUTED_WITHDRAWAL_REASON,
							TransactionHistory:
								request.currentTransactionId && request.currentTransactionId !== observedTransactionId
									? { connect: { id: request.currentTransactionId } }
									: undefined,
							CurrentTransaction: { connect: { id: observedTransactionId } },
							...(isAlreadyParked
								? {}
								: {
										ActionHistory: { connect: { id: request.nextActionId } },
										NextAction: {
											create: {
												requestedAction: PaymentAction.None,
												errorNote: unresolvedDisputedWithdrawalNote(txId),
												errorType: null,
											},
										},
									}),
						},
					});
					hasApplied = true;
					hasUnresolvedDisputedWithdrawal = true;
					continue;
				}
				if (
					request.NextAction.requestedAction === PaymentAction.None ||
					request.CurrentTransaction == null ||
					request.CurrentTransaction.layer !== TransactionLayer.L2 ||
					request.CurrentTransaction.hydraHeadId !== hydraHeadId
				) {
					continue;
				}
				const inputValue = parsePersistedHydraValue(request.currentHydraUtxoValue);
				if (!inputValue) {
					hasEvidenceFailure = true;
					continue;
				}
				const newState = authorizedTerminalState({
					request,
					buyer: request.BuyerWallet,
					seller: request.SmartContractWallet,
					inputValue,
					input: spend,
					evidence: transactionEvidence,
					slotConfig,
					resultTime: request.submitResultTime,
					unlockTime: request.unlockTime,
				});
				if (!newState) {
					hasEvidenceFailure = true;
					continue;
				}

				const observedTransactionId = await ensureObservedTransaction(tx, {
					hydraHeadId,
					txId,
					currentTransaction: request.CurrentTransaction,
					previousState: request.onChainState,
					newState,
				});
				const newAction = convertNewPaymentActionAndError(request.NextAction.requestedAction, newState);
				await tx.paymentRequest.update({
					where: { id: request.id },
					data: {
						currentHydraUtxoTxHash: null,
						currentHydraUtxoOutputIndex: null,
						currentHydraUtxoValue: Prisma.DbNull,
						unresolvedHydraTerminalTxHash: null,
						unresolvedHydraTerminalReason: null,
						onChainState: newState,
						ActionHistory: { connect: { id: request.nextActionId } },
						NextAction: {
							create: {
								requestedAction: newAction.action,
								errorNote: newAction.errorNote,
								errorType: newAction.errorType,
							},
						},
						TransactionHistory:
							request.currentTransactionId && request.currentTransactionId !== observedTransactionId
								? { connect: { id: request.currentTransactionId } }
								: undefined,
						CurrentTransaction: { connect: { id: observedTransactionId } },
					},
				});
				await releaseBlockedWallet(tx, request.CurrentTransaction);
				hasApplied = true;
			}

			const purchaseRequests = await tx.purchaseRequest.findMany({
				where: {
					paymentSourceId,
					layer: TransactionLayer.L2,
					currentHydraUtxoTxHash: { in: inputHashes },
				},
				include: {
					NextAction: true,
					CurrentTransaction: { include: { BlocksWallet: true } },
					TransactionHistory: { select: { txHash: true } },
					PaidFunds: true,
					SellerWallet: true,
					SmartContractWallet: true,
				},
			});
			for (const request of purchaseRequests) {
				const requestIdentifier = decodeBlockchainIdentifier(request.blockchainIdentifier);
				const spend = candidateInputs.find(
					(candidate) =>
						candidate.txHash === request.currentHydraUtxoTxHash &&
						candidate.outputIndex === request.currentHydraUtxoOutputIndex,
				);
				if (!spend) continue;
				hasCandidate = true;
				if (
					requestIdentifier == null ||
					continuationReferenceSignatures.has(requestIdentifier.signature) ||
					request.currentHydraUtxoTxHash == null ||
					request.currentHydraUtxoOutputIndex == null ||
					request.TransactionHistory.some((history) => history.txHash === txId) ||
					!requestParticipantsMatch('purchase', request, head, paymentSourceId)
				) {
					continue;
				}
				if (!request.SmartContractWallet || !request.SellerWallet) continue;
				const isUnresolvedDisputedSpend = isUnresolvedDisputedWithdrawal({
					request,
					input: spend,
					evidence: transactionEvidence,
					slotConfig,
				});
				if (isUnresolvedDisputedSpend) {
					const matchingCurrentTransaction =
						request.CurrentTransaction?.layer === TransactionLayer.L2 &&
						request.CurrentTransaction.hydraHeadId === hydraHeadId &&
						(request.CurrentTransaction.txHash === txId || request.CurrentTransaction.intendedTxHash === txId)
							? request.CurrentTransaction
							: null;
					const observedTransactionId = await ensureObservedTransaction(tx, {
						hydraHeadId,
						txId,
						currentTransaction: matchingCurrentTransaction,
						previousState: request.onChainState,
						newState: OnChainState.Disputed,
					});
					if (matchingCurrentTransaction) await releaseBlockedWallet(tx, matchingCurrentTransaction);
					const conflictingPendingTransaction =
						request.CurrentTransaction?.id !== observedTransactionId &&
						request.CurrentTransaction?.status === TransactionStatus.Pending &&
						request.CurrentTransaction.layer === TransactionLayer.L2 &&
						request.CurrentTransaction.hydraHeadId === hydraHeadId
							? request.CurrentTransaction
							: null;
					if (conflictingPendingTransaction) {
						await tx.transaction.update({
							where: { id: conflictingPendingTransaction.id },
							data: { status: TransactionStatus.RolledBack },
						});
						await releaseBlockedWallet(tx, conflictingPendingTransaction);
					}
					const isAlreadyParked =
						request.unresolvedHydraTerminalTxHash === txId &&
						request.unresolvedHydraTerminalReason === UNRESOLVED_DISPUTED_WITHDRAWAL_REASON &&
						request.NextAction.requestedAction === PurchasingAction.None;
					await tx.purchaseRequest.update({
						where: { id: request.id },
						data: {
							unresolvedHydraTerminalTxHash: txId,
							unresolvedHydraTerminalReason: UNRESOLVED_DISPUTED_WITHDRAWAL_REASON,
							TransactionHistory:
								request.currentTransactionId && request.currentTransactionId !== observedTransactionId
									? { connect: { id: request.currentTransactionId } }
									: undefined,
							CurrentTransaction: { connect: { id: observedTransactionId } },
							...(isAlreadyParked
								? {}
								: {
										ActionHistory: { connect: { id: request.nextActionId } },
										NextAction: {
											create: {
												requestedAction: PurchasingAction.None,
												errorNote: unresolvedDisputedWithdrawalNote(txId),
												errorType: null,
											},
										},
									}),
						},
					});
					hasApplied = true;
					hasUnresolvedDisputedWithdrawal = true;
					continue;
				}
				if (
					request.NextAction.requestedAction === PurchasingAction.None ||
					request.CurrentTransaction == null ||
					request.CurrentTransaction.layer !== TransactionLayer.L2 ||
					request.CurrentTransaction.hydraHeadId !== hydraHeadId
				) {
					continue;
				}
				const inputValue = parsePersistedHydraValue(request.currentHydraUtxoValue);
				if (!inputValue) {
					hasEvidenceFailure = true;
					continue;
				}
				const newState = authorizedTerminalState({
					request,
					buyer: request.SmartContractWallet,
					seller: request.SellerWallet,
					inputValue,
					input: spend,
					evidence: transactionEvidence,
					slotConfig,
					resultTime: request.submitResultTime,
					unlockTime: request.unlockTime,
				});
				if (!newState) {
					hasEvidenceFailure = true;
					continue;
				}

				const observedTransactionId = await ensureObservedTransaction(tx, {
					hydraHeadId,
					txId,
					currentTransaction: request.CurrentTransaction,
					previousState: request.onChainState,
					newState,
				});
				const newAction = convertNewPurchasingActionAndError(request.NextAction.requestedAction, newState);
				await tx.purchaseRequest.update({
					where: { id: request.id },
					data: {
						currentHydraUtxoTxHash: null,
						currentHydraUtxoOutputIndex: null,
						currentHydraUtxoValue: Prisma.DbNull,
						unresolvedHydraTerminalTxHash: null,
						unresolvedHydraTerminalReason: null,
						onChainState: newState,
						ActionHistory: { connect: { id: request.nextActionId } },
						NextAction: {
							create: {
								requestedAction: newAction.action,
								errorNote: newAction.errorNote,
								errorType: newAction.errorType,
							},
						},
						TransactionHistory:
							request.currentTransactionId && request.currentTransactionId !== observedTransactionId
								? { connect: { id: request.currentTransactionId } }
								: undefined,
						CurrentTransaction: { connect: { id: observedTransactionId } },
					},
				});
				await releaseBlockedWallet(tx, request.CurrentTransaction);
				hasApplied = true;
			}
		},
		{
			isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
			timeout: CONSTANTS.TRANSACTION_WAIT.SERIALIZABLE,
			maxWait: CONSTANTS.TRANSACTION_WAIT.SERIALIZABLE,
		},
	);
	if (hasUnresolvedDisputedWithdrawal) {
		logger.warn('[HydraDatumSync] recorded unresolved disputed terminal spend without changing escrow money state', {
			hydraHeadId,
			txId,
			reason: UNRESOLVED_DISPUTED_WITHDRAWAL_REASON,
		});
	}
	// A transaction may touch multiple local escrows. Never let one successful
	// application discard replay evidence needed by another malformed candidate.
	return isAdmissionDenied || hasEvidenceFailure
		? 'retry'
		: hasApplied
			? 'applied'
			: hasCandidate
				? 'retry'
				: 'irrelevant';
}
