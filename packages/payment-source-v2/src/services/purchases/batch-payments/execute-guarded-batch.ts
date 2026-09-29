import { randomUUID } from 'node:crypto';
import { PurchaseErrorType, PurchasingAction } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { decodeBlockchainIdentifier } from '@masumi/payment-core/blockchain-identifier';
// V2 mesh line: the guarded builder and its signer must never mix with the root (V1) provider or wallet.
import { BlockfrostProvider, MeshWallet, resolveTxHash } from '@meshsdk/core';
import { convertNetwork, convertNetworkToId } from '@/utils/converter/network-convert';
import { decrypt } from '@/utils/security/encryption';
import { withMeshCostModelLock } from '@/utils/mesh-cost-model-sync';
import {
	CosignTransportError,
	jobHashOf,
	mergeCosignWitnesses,
	requestCosign,
	type CosignIntent,
} from '../../../smart-wallet/cosign-client';
import {
	buildGuardedLockTx,
	GuardedTxTooLargeError,
	type GuardedLockBuild,
	type GuardedLockOutput,
} from '../../../smart-wallet/guarded-lock-builder';
import { fetchWalletUtxo, loadSmartWalletScript, readWalletDatum } from '../../../smart-wallet/wallet-lifecycle';
import {
	batchLockDatum,
	recordBatchPresubmit,
	submitBatchTx,
	type BatchedRequest,
	type BatchPairingOutcome,
	type PaymentSourceWithWallets,
	type WalletPairing,
} from './execute-batch';
import { classifyCosignResult, type CosignDisposition, type CosignOutcome } from './cosign-disposition';
import { cosignConfigOrNull } from './cosign-config';

/** One rebuild with the admitted set per tick; a second denial goes back to the queue. */
const MAX_COSIGN_REBUILDS = 1;

/** A guarded wallet governs lovelace only, so packing never hands it a purchase with native tokens. */
function lockLovelaceOf(request: BatchedRequest): bigint {
	let lovelace = 0n;
	for (const funds of request.paymentRequest.PaidFunds) {
		if (funds.unit !== '' && funds.unit !== 'lovelace') {
			throw new Error(
				`guarded wallets lock lovelace only; purchase ${request.paymentRequest.id} carries ${funds.unit}`,
			);
		}
		lovelace += funds.amount;
	}
	return lovelace;
}

function lockOutputOf(walletPairing: WalletPairing, request: BatchedRequest): GuardedLockOutput {
	return {
		address: walletPairing.scriptAddress,
		amount: [{ unit: 'lovelace', quantity: lockLovelaceOf(request).toString() }],
		datum: batchLockDatum(walletPairing, request).value,
	};
}

function intentOf(request: BatchedRequest, outputIndex: number): CosignIntent {
	const purchase = request.paymentRequest;
	const agentIdentifier =
		purchase.agentIdentifier ?? decodeBlockchainIdentifier(purchase.blockchainIdentifier)?.agentIdentifier;
	if (agentIdentifier == null) {
		throw new Error(`purchase ${purchase.id} has no agent identifier to show the co-signer`);
	}
	return {
		purchaseId: purchase.id,
		outputIndex,
		counterparty: `sellerVkeyHash:${purchase.SellerWallet.walletVkey}`,
		amount: lockLovelaceOf(request).toString(),
		asset: 'lovelace',
		jobHash: jobHashOf(purchase.inputHash),
		agentIdentifier,
	};
}

/** Park or requeue the purchases the quorum did not co-sign. Nothing was submitted for them. */
async function recordCosignDispositions(requests: BatchedRequest[], refused: Map<string, CosignDisposition>) {
	for (const request of requests) {
		const disposition = refused.get(request.paymentRequest.id);
		if (disposition == null) continue;
		await prisma.purchaseRequest.update({
			where: { id: request.paymentRequest.id },
			data: {
				ActionHistory: { connect: { id: request.paymentRequest.nextActionId } },
				NextAction: {
					create:
						disposition.kind === 'retry'
							? {
									// errorType stays null: the batch job selects only queued rows without one.
									requestedAction: PurchasingAction.FundsLockingRequested,
									errorType: null,
									errorNote: disposition.note,
								}
							: {
									requestedAction: PurchasingAction.WaitingForManualAction,
									errorType: disposition.policy ? PurchaseErrorType.PolicyDenied : PurchaseErrorType.Unknown,
									errorNote: disposition.note,
								},
				},
			},
		});
	}
}

/**
 * Lock a batch from a guarded smart wallet: build the AgentSpend, ask the
 * Exchain quorum to co-sign, then submit through the same pre-submit and
 * submit steps as a plain batch.
 *
 * The quorum is asked BEFORE the purchases move to the shared Transaction row.
 * A refusal therefore leaves them untouched, and each gets its own disposition.
 * Without the quorum's witnesses the transaction cannot land on chain, so
 * there is never an unguarded fallback.
 */
export async function executeGuardedBatch(
	walletPairing: WalletPairing,
	paymentContract: PaymentSourceWithWallets,
): Promise<BatchPairingOutcome> {
	const walletId = walletPairing.walletId;
	const sharedTxId = walletPairing.placeholderTransactionId;
	const guarded = walletPairing.guarded;
	const refuseAll = async (disposition: CosignDisposition): Promise<BatchPairingOutcome> => {
		const requestIds = walletPairing.batchedRequests.map((request) => request.paymentRequest.id);
		await recordCosignDispositions(
			walletPairing.batchedRequests,
			new Map(requestIds.map((requestId) => [requestId, disposition])),
		);
		walletPairing.batchedRequests = [];
		return { status: 'cosign-refused', walletId, sharedTxId, requestIds };
	};
	const preSubmitFailed = (error: unknown): BatchPairingOutcome => ({
		status: 'pre-submit-failed',
		walletId,
		sharedTxId,
		requestIds: walletPairing.batchedRequests.map((request) => request.paymentRequest.id),
		error,
	});

	if (guarded == null) return preSubmitFailed(new Error('executeGuardedBatch called for a plain wallet'));
	const cosignConfig = cosignConfigOrNull();
	if (cosignConfig == null) {
		return refuseAll({ kind: 'retry', note: 'Exchain co-signing is not configured on this node; retrying' });
	}
	const network = convertNetwork(paymentContract.network);
	const script = loadSmartWalletScript({
		ownerAddress: guarded.ownerAddress,
		quorumVkhs: guarded.quorumVkhs,
		threshold: guarded.threshold,
		network,
	});
	if (script.address !== guarded.scriptAddress || script.policyId !== guarded.policyId) {
		return refuseAll({
			kind: 'manual',
			policy: false,
			note: 'The guarded wallet script no longer matches its attach record; detach and attach it again',
		});
	}
	const cosignerVkhs = guarded.quorumVkhs.slice(0, guarded.threshold);
	const rpcApiKey = paymentContract.PaymentSourceConfig.rpcProviderApiKey;
	const hotWallet = paymentContract.HotWallets.find((candidate) => candidate.id === walletId);
	if (hotWallet == null) return preSubmitFailed(new Error(`hot wallet ${walletId} is not in this payment source`));
	const provider = new BlockfrostProvider(rpcApiKey);
	const agent = new MeshWallet({
		networkId: convertNetworkToId(paymentContract.network),
		fetcher: provider,
		submitter: provider,
		key: { type: 'mnemonic', words: decrypt(hotWallet.Secret.encryptedMnemonic).split(' ') },
	});
	const batchId = randomUUID();
	let rebuilds = 0;

	for (;;) {
		const batched = walletPairing.batchedRequests;
		if (batched.length === 0) return { status: 'cosign-refused', walletId, sharedTxId, requestIds: [] };
		const requestIds = batched.map((request) => request.paymentRequest.id);

		let built: GuardedLockBuild;
		let walletUtxoRef: string;
		try {
			const walletUtxo = await fetchWalletUtxo(provider, script, guarded.stateTokenName);
			const agentUtxos = await agent.getUtxos();
			walletUtxoRef = `${walletUtxo.input.txHash}#${walletUtxo.input.outputIndex}`;
			const minPayByTime = batched.reduce<bigint>(
				(min, request) => (request.paymentRequest.payByTime! < min ? request.paymentRequest.payByTime! : min),
				batched[0].paymentRequest.payByTime!,
			);
			// Same lock as the plain path: the builder syncs mesh's process-global cost models.
			built = await withMeshCostModelLock(rpcApiKey, () =>
				buildGuardedLockTx({
					provider,
					rpcApiKey,
					network,
					wallet: { scriptCode: script.scriptCode, address: script.address },
					walletUtxo,
					walletDatum: readWalletDatum(walletUtxo),
					agentAddress: walletPairing.changeAddress,
					agentUtxos,
					cosignerVkhs,
					locks: batched.map((request) => lockOutputOf(walletPairing, request)),
					constrainAfterMs: minPayByTime,
				}),
			);
		} catch (error) {
			if (error instanceof GuardedTxTooLargeError && batched.length > 1) {
				const dropped = batched[batched.length - 1];
				await recordCosignDispositions(
					[dropped],
					new Map([[dropped.paymentRequest.id, { kind: 'retry', note: 'Guarded batch too large; retrying' }]]),
				);
				walletPairing.batchedRequests = batched.slice(0, -1);
				continue;
			}
			logger.warn('guarded batch build failed pre-broadcast', { walletId, requestIds, error });
			return preSubmitFailed(error);
		}

		let outcome: CosignOutcome;
		try {
			outcome = await requestCosign(cosignConfig, {
				unsignedTx: built.unsignedTx,
				batchId,
				walletUtxoRef,
				intents: batched.map((request, position) => intentOf(request, built.lockOutputIndexes[position])),
				context: {
					nodeId: cosignConfig.nodeId,
					orgId: cosignConfig.orgId,
					submittedAt: new Date().toISOString(),
					walletAddress: script.address,
				},
			});
		} catch (error) {
			if (!(error instanceof CosignTransportError)) return preSubmitFailed(error);
			outcome = { transportError: error.message };
		}

		if ('httpStatus' in outcome && outcome.httpStatus === 409 && outcome.denied.alarm) {
			logger.error('Exchain raised an alarm on a guarded batch', {
				walletId,
				code: outcome.denied.denied,
				journalRef: outcome.denied.journalRef,
			});
		}
		const classification = classifyCosignResult(outcome, requestIds, rebuilds < MAX_COSIGN_REBUILDS);
		if (classification.kind === 'refused') {
			await recordCosignDispositions(batched, classification.refused);
			walletPairing.batchedRequests = [];
			logger.info('guarded batch not co-signed; purchases requeued or parked', { walletId, requestIds });
			return { status: 'cosign-refused', walletId, sharedTxId, requestIds };
		}
		if (classification.kind === 'rebuild') {
			await recordCosignDispositions(batched, classification.refused);
			const keep = new Set(classification.keep);
			walletPairing.batchedRequests = batched.filter((request) => keep.has(request.paymentRequest.id));
			rebuilds++;
			continue;
		}
		if (!('httpStatus' in outcome) || outcome.httpStatus !== 200) {
			return preSubmitFailed(new Error('co-sign classified as approved without an approval'));
		}

		let signedTx: string;
		try {
			const merged = mergeCosignWitnesses(
				built.unsignedTx,
				{ txHash: built.txHash, signerVkhs: cosignerVkhs },
				outcome.approved.witnessSetHex,
			);
			signedTx = await agent.signTx(merged, true);
			if (resolveTxHash(signedTx) !== built.txHash) throw new Error('the agent signature changed the frozen body');
		} catch (error) {
			return preSubmitFailed(error);
		}

		const presubmitTxId = await recordBatchPresubmit(walletPairing);
		return submitBatchTx({
			walletPairing,
			sharedTxId: presubmitTxId,
			signedTx,
			completeTx: built.unsignedTx,
			invalidAfter: built.validity.invalidAfter,
			requestIds,
		});
	}
}
