import { OnChainState, TransactionStatus } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { convertNetwork } from '@masumi/payment-core/network';
import { onChainStateFromSmartContractState } from '@masumi/payment-core/smart-contract-state';
import { deserializeDatum } from '@meshsdk/core';
import { decodeV1ContractDatum } from '@/utils/converter/string-datum-convert';
import { createApiClient } from '@/services/shared';

export type RepairTargetKind = 'purchase' | 'payment';

export type RepairValidation = {
	txHash: string;
	outputIndex: number;
	derivedOnChainState: OnChainState;
	resultHash: string | null;
	blockchainIdentifierMatches: true;
};

export class RepairValidationError extends Error {
	readonly detail: string;
	constructor(detail: string) {
		super(detail);
		this.name = 'RepairValidationError';
		this.detail = detail;
	}
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
	network: 'Mainnet' | 'Preprod';
	rpcProviderApiKey: string;
}): Promise<RepairValidation> {
	const blockfrost = createApiClient(params.network, params.rpcProviderApiKey);

	let utxos;
	try {
		utxos = await blockfrost.txsUtxos(params.txHash);
	} catch (error) {
		throw new RepairValidationError(
			`Transaction ${params.txHash} could not be read from the chain: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	const contractOutputs = utxos.outputs.filter((output) => output.address === params.smartContractAddress);
	if (contractOutputs.length === 0) {
		throw new RepairValidationError(
			`Transaction ${params.txHash} has no output at this payment source's contract address (${params.smartContractAddress}), so it cannot be this request's escrow transaction.`,
		);
	}

	const meshNetwork = convertNetwork(params.network);

	for (const output of contractOutputs) {
		if (output.inline_datum == null) continue;

		let decoded;
		try {
			const datum: unknown = deserializeDatum(output.inline_datum);
			decoded = decodeV1ContractDatum(datum, meshNetwork);
		} catch {
			continue;
		}
		if (decoded == null) continue;
		if (decoded.blockchainIdentifier !== params.blockchainIdentifier) continue;

		return {
			txHash: params.txHash,
			outputIndex: output.output_index,
			derivedOnChainState: onChainStateFromSmartContractState(decoded.state),
			resultHash: decoded.resultHash == null || decoded.resultHash.length === 0 ? null : decoded.resultHash,
			blockchainIdentifierMatches: true,
		};
	}

	throw new RepairValidationError(
		`Transaction ${params.txHash} has ${contractOutputs.length} output(s) at the contract address, but none carries a datum for this request's blockchainIdentifier. It belongs to a different request.`,
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
	tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
	params: { txHash: string; existingIds: string[]; newOnChainState: OnChainState },
): Promise<string> {
	if (params.existingIds.length > 0) {
		const existing = await tx.transaction.findFirst({
			where: { id: { in: params.existingIds }, txHash: params.txHash },
			select: { id: true },
		});
		if (existing != null) return existing.id;
	}

	const created = await tx.transaction.create({
		data: {
			txHash: params.txHash,
			status: TransactionStatus.Confirmed,
			newOnChainState: params.newOnChainState,
		},
		select: { id: true },
	});
	return created.id;
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
}): Promise<RepairResult> {
	const forced = params.validation == null;
	const newOnChainState = params.validation?.derivedOnChainState ?? params.forcedOnChainState;
	if (newOnChainState == null) {
		throw new RepairValidationError('An on-chain state must be supplied when validation is skipped');
	}

	return await prisma.$transaction(async (tx) => {
		const request =
			params.kind === 'purchase'
				? await tx.purchaseRequest.findUnique({
						where: { id: params.requestId },
						select: {
							id: true,
							onChainState: true,
							currentTransactionId: true,
							TransactionHistory: { select: { id: true } },
						},
					})
				: await tx.paymentRequest.findUnique({
						where: { id: params.requestId },
						select: {
							id: true,
							onChainState: true,
							currentTransactionId: true,
							TransactionHistory: { select: { id: true } },
						},
					});

		if (request == null) {
			throw new RepairValidationError(`${params.kind} request ${params.requestId} not found`);
		}

		const existingIds = [
			...request.TransactionHistory.map((x) => x.id),
			...(request.currentTransactionId != null ? [request.currentTransactionId] : []),
		];

		const transactionId = await resolveTransactionRow(tx, {
			txHash: params.txHash,
			existingIds,
			newOnChainState,
		});

		// Connect to history as well as current. A terminal action has no later
		// step to archive it, and an entry missing from history is invisible to
		// error-state-recovery's candidate selection.
		const data = {
			currentTransactionId: transactionId,
			onChainState: newOnChainState,
			...(params.validation?.resultHash != null ? { resultHash: params.validation.resultHash } : {}),
			TransactionHistory: { connect: { id: transactionId } },
		};

		if (params.kind === 'purchase') {
			await tx.purchaseRequest.update({ where: { id: params.requestId }, data });
		} else {
			await tx.paymentRequest.update({ where: { id: params.requestId }, data });
		}

		logger.warn('Request transaction repaired manually', {
			kind: params.kind,
			requestId: params.requestId,
			txHash: params.txHash,
			transactionId,
			previousOnChainState: request.onChainState,
			newOnChainState,
			forced,
		});

		return {
			requestId: params.requestId,
			txHash: params.txHash,
			transactionId,
			previousOnChainState: request.onChainState,
			newOnChainState,
			forced,
		};
	});
}
