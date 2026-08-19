/**
 * Applying one confirmed in-head transaction to local escrow state.
 *
 * Confirmation is only ever derived from immutable snapshot evidence — a
 * validated continuation datum, or an exact persisted UTxO spend with the
 * expected terminal redeemer — never from the requested action alone. The
 * connection manager owns queuing and deduplication (per head, per tx id);
 * this module owns what a confirmation means once its turn comes.
 */

import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { deserializeDatum } from '@meshsdk/core';
import { Network, OnChainState, TransactionStatus } from '@/generated/prisma/client';
import { HydraProvider, type HydraConfirmedTransaction } from '@/lib/hydra';
import { HydraNode } from '@/lib/hydra/hydra/node';
import { decodeV2ContractDatum } from '@/utils/converter/string-datum-convert';
import { smartContractStateToOnChainState } from '@/utils/logic/l2-datum-validation';
import {
	applyDatumStateToLocalRequests,
	findLocallyRelevantHydraRequestIdentifiers,
	type HydraDatumApplyOutcome,
} from './hydra-datum-sync';
import { applyTerminalHydraSpends } from './hydra-datum-terminal';
import { parseHydraTransactionEvidence } from './hydra-transaction-evidence';

/** What this pipeline needs from the head's live session, if one exists. */
export interface TxConfirmedHost {
	getProvider(hydraHeadId: string): HydraProvider | null;
	getNode(hydraHeadId: string): HydraNode | null;
	flushHeadStatus(hydraHeadId: string): Promise<void>;
	isStatusQuarantined(hydraHeadId: string): boolean;
}

export async function applyConfirmedHydraTransaction(
	host: TxConfirmedHost,
	hydraHeadId: string,
	txId: string,
	confirmedTransaction?: HydraConfirmedTransaction,
): Promise<HydraDatumApplyOutcome> {
	// Lifecycle and transaction frames use separate queues, but a rollback
	// observed first must close its durable admission gate before a later
	// TxConfirmed frame can mutate escrow state.
	await host.flushHeadStatus(hydraHeadId);
	if (host.isStatusQuarantined(hydraHeadId)) return 'retry';
	const tx = await prisma.transaction.findFirst({
		where: {
			OR: [{ txHash: txId }, { txHash: null, intendedTxHash: txId }],
			layer: 'L2',
			hydraHeadId,
			status: TransactionStatus.Pending,
		},
		select: { id: true },
	});

	if (!tx) {
		return await syncHydraDatumStateFromConfirmedTx(host, hydraHeadId, txId, confirmedTransaction);
	}

	// Every L2 state change is confirmed from immutable snapshot evidence: a
	// validated continuation datum, or an exact persisted UTxO spend with the
	// expected terminal redeemer. Never derive confirmation from the requested
	// action alone; that would turn a malformed/missing output into success.
	const syncOutcome = await syncHydraDatumStateFromConfirmedTx(host, hydraHeadId, txId, confirmedTransaction);
	if (syncOutcome === 'retry') {
		// A transaction can touch multiple local escrows. Even if one output
		// confirmed the shared Transaction row, retain the replay evidence until
		// every dependent datum/spend has reached a durable outcome.
		return 'retry';
	}
	const refreshed = await prisma.transaction.findUnique({
		where: { id: tx.id },
		select: { status: true },
	});
	if (refreshed?.status === TransactionStatus.Pending) {
		logger.warn('[HydraConnectionManager] Refusing unvalidated L2 confirmation', {
			hydraHeadId,
			txId,
		});
		return 'retry';
	}
	return refreshed?.status === TransactionStatus.Confirmed ? 'applied' : 'retry';
}

async function syncHydraDatumStateFromConfirmedTx(
	host: TxConfirmedHost,
	hydraHeadId: string,
	txId: string,
	confirmedTransaction?: HydraConfirmedTransaction,
): Promise<HydraDatumApplyOutcome> {
	try {
		if (host.isStatusQuarantined(hydraHeadId)) return 'retry';
		let hasApplied = false;
		let hasRetry = false;
		const provider = host.getProvider(hydraHeadId);

		const hydraHead = await prisma.hydraHead.findUnique({
			where: { id: hydraHeadId },
			include: {
				HydraRelation: {
					include: {
						LocalHotWallet: {
							include: {
								PaymentSource: true,
							},
						},
					},
				},
			},
		});

		if (!hydraHead || !hydraHead.isEnabled || hydraHead.initTxHash == null) {
			// Cross-replica disablement and independent InitTx verification are
			// durable admission boundaries. A stale local socket may retain valid
			// frames, but it must not mutate escrow state after either gate closes.
			return 'retry';
		}

		const paymentSource = hydraHead.HydraRelation.LocalHotWallet.PaymentSource;
		const network = paymentSource.network === Network.Mainnet ? 'mainnet' : 'preprod';
		const resolvedConfirmedTransaction =
			confirmedTransaction ?? host.getNode(hydraHeadId)?.getConfirmedTransaction(txId) ?? null;
		const transactionEvidence = resolvedConfirmedTransaction
			? parseHydraTransactionEvidence(resolvedConfirmedTransaction.cborHex)
			: null;
		if (resolvedConfirmedTransaction && !transactionEvidence) return 'retry';
		const confirmationTimeMs = resolvedConfirmedTransaction?.confirmedAtMs ?? null;
		type ObservedOutput = {
			input: { txHash: string; outputIndex: number };
			output: {
				address: string;
				plutusData: string | null;
				amount: Array<{ unit: string; quantity: string }>;
			};
		};
		let transactionOutputs: ObservedOutput[];
		if (transactionEvidence) {
			// Decode the confirmed transaction's own immutable outputs. Reading the
			// current snapshot by tx hash loses T1 when one snapshot confirms T1→T2.
			transactionOutputs = transactionEvidence.outputs.map((output) => ({
				input: { txHash: txId, outputIndex: output.outputIndex },
				output: {
					address: output.address,
					plutusData: output.plutusData,
					amount: output.amount,
				},
			}));
		} else if (provider) {
			transactionOutputs = (await provider.fetchUTxOs(txId)).map((utxo) => ({
				input: utxo.input,
				output: {
					address: utxo.output.address,
					plutusData: utxo.output.plutusData ?? null,
					amount: utxo.output.amount,
				},
			}));
		} else {
			transactionOutputs = [];
		}

		const contractOutputs = transactionOutputs.filter((utxo) => {
			return utxo.output.address === paymentSource.smartContractAddress && utxo.output.plutusData != null;
		});

		const decodedOutputs: Array<{
			output: (typeof contractOutputs)[number];
			decoded: NonNullable<ReturnType<typeof decodeV2ContractDatum>>;
			state: OnChainState;
		}> = [];
		for (const output of contractOutputs) {
			try {
				const outputDatum = output.output.plutusData;
				if (!outputDatum) continue;
				const decodedDatum: unknown = deserializeDatum(outputDatum);
				const decodedNewContract = decodeV2ContractDatum(decodedDatum, network, paymentSource.smartContractAddress);
				if (!decodedNewContract) continue;
				// Strict 1:1 datum-state → OnChainState (shared with the reconciler).
				const derivedOnChainState = smartContractStateToOnChainState(decodedNewContract.state);
				if (!derivedOnChainState) continue;
				decodedOutputs.push({ output, decoded: decodedNewContract, state: derivedOnChainState });
			} catch (error) {
				// Unrelated script-address outputs cannot suppress proof of a valid
				// terminal spend elsewhere in the same confirmed transaction.
				logger.warn('[HydraConnectionManager] Ignoring malformed contract output', {
					hydraHeadId,
					txId,
					outputIndex: output.input.outputIndex,
					error,
				});
			}
		}

		const identifierCounts = new Map<string, number>();
		for (const decodedOutput of decodedOutputs) {
			identifierCounts.set(
				decodedOutput.decoded.blockchainIdentifier,
				(identifierCounts.get(decodedOutput.decoded.blockchainIdentifier) ?? 0) + 1,
			);
		}
		const duplicateIdentifiers = [...identifierCounts]
			.filter(([, count]) => count > 1)
			.map(([identifier]) => identifier);
		const locallyRelevantDuplicateIdentifiers = await findLocallyRelevantHydraRequestIdentifiers(
			paymentSource.id,
			duplicateIdentifiers,
		);
		for (const decodedOutput of decodedOutputs) {
			if ((identifierCounts.get(decodedOutput.decoded.blockchainIdentifier) ?? 0) !== 1) {
				if (locallyRelevantDuplicateIdentifiers.has(decodedOutput.decoded.blockchainIdentifier)) {
					hasRetry = true;
					logger.warn('[HydraConnectionManager] duplicate outputs for local identifier; refusing ambiguous tx', {
						hydraHeadId,
						txId,
						blockchainIdentifier: decodedOutput.decoded.blockchainIdentifier,
					});
				}
				continue;
			}
			const datumOutcome = await applyDatumStateToLocalRequests({
				hydraHeadId,
				txId,
				paymentSourceId: paymentSource.id,
				network: paymentSource.network,
				decoded: decodedOutput.decoded,
				newOnChainState: decodedOutput.state,
				outputAmounts: decodedOutput.output.output.amount,
				outputReference: decodedOutput.output.input,
				transactionEvidence,
				confirmationTimeMs,
			});
			hasApplied ||= datumOutcome === 'applied';
			hasRetry ||= datumOutcome === 'retry';
		}

		if (transactionEvidence) {
			const terminalOutcome = await applyTerminalHydraSpends({
				hydraHeadId,
				txId,
				paymentSourceId: paymentSource.id,
				transactionEvidence,
			});
			hasApplied ||= terminalOutcome === 'applied';
			hasRetry ||= terminalOutcome === 'retry';
		}
		return hasRetry ? 'retry' : hasApplied ? 'applied' : 'irrelevant';
	} catch (error) {
		logger.error('[HydraConnectionManager] Failed fallback L2 datum sync', {
			hydraHeadId,
			txId,
			error,
		});
		return 'retry';
	}
}
