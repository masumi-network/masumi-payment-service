import { RegistrationState } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import type { LanguageVersion } from '@meshsdk/core';
import { lockAndQueryInboxAgentRegistrationRequests } from '@/utils/db/lock-and-query-inbox-agent-registration-request';
import { DEFAULTS, SERVICE_CONSTANTS } from '@masumi/payment-core/config';
import { advancedRetry, delayErrorResolver } from 'advanced-retry';
import { interpretBlockchainError } from '@masumi/payment-core/blockchain-error-interpreter';
import { sortUtxosByLovelaceDesc } from '@/utils/utxo';
import {
	createMeshProvider,
	createPendingTransaction,
	loadHotWalletSession,
	updateCurrentTransactionHash,
} from '@/services/shared';
import {
	generateRegistryAssetNameV2,
	generateRegistryMintTransaction,
	resolveRegistryFundingLovelace,
	resolveRegistryRecipientWalletAddress,
} from '@/services/registry/shared';
import { WALLET_SPLITTER_LOVELACE } from '../../../builders/batch-helpers';
import type { BatchRegistryMintItem } from '../../../builders/batch-registry';
import { ensureCollateralReady } from '../../wallet-collateral/ensure-collateral-ready';
import {
	MAX_COLLATERAL_PREP_FAILURES,
	recordInboxPrepFailure,
	resetInboxPrepFailureCount,
} from '../../wallet-collateral/prep-failure-guard';
import { buildInboxAgentMetadata } from '../metadata';

export type LockedPaymentSource = Awaited<ReturnType<typeof lockAndQueryInboxAgentRegistrationRequests>>[number];
export type InboxRequestRecord = LockedPaymentSource['InboxAgentRegistrationRequests'][number];

export type ValidatedInboxItem = {
	request: InboxRequestRecord;
	item: BatchRegistryMintItem;
	assetName: string;
	policyId: string;
};

export async function markRequestFailed(
	request: InboxRequestRecord,
	error: unknown,
	options: { unlockWallet?: boolean } = {},
): Promise<void> {
	// unlockWallet=true when this failure frees the wallet (terminal / all-failed
	// path). In the per-item validation loop the shared wallet lock must survive
	// so a concurrent service can't grab the wallet and submit a conflicting mint
	// from the same UTxO set while the batch keeps building the remaining items;
	// the terminal paths (all-failed unlock, submit success, markBatchFailed) free
	// it.
	const unlockWallet = options.unlockWallet ?? true;
	logger.error(`Error registering V2 inbox agent ${request.id}`, { error });
	await prisma.inboxAgentRegistrationRequest.update({
		where: { id: request.id },
		data: {
			state: RegistrationState.RegistrationFailed,
			error: interpretBlockchainError(error),
			...(unlockWallet ? { SmartContractWallet: { update: { lockedAt: null } } } : {}),
		},
	});
}

export async function unlockHotWallet(hotWalletId: string): Promise<void> {
	try {
		await prisma.hotWallet.update({
			where: { id: hotWalletId, deletedAt: null },
			data: { lockedAt: null },
		});
	} catch (error) {
		logger.warn('Failed to release hot wallet lock after V2 inbox register batch bail-out', {
			hotWalletId,
			error,
		});
	}
}

async function processSingleRegistration(
	validated: ValidatedInboxItem,
	paymentSource: LockedPaymentSource,
	network: 'mainnet' | 'preprod',
	script: { version: LanguageVersion; code: string },
): Promise<void> {
	const request = validated.request;
	const walletSession = await loadHotWalletSession({
		network: paymentSource.network,
		rpcProviderApiKey: paymentSource.PaymentSourceConfig.rpcProviderApiKey,
		encryptedMnemonic: request.SmartContractWallet.Secret.encryptedMnemonic,
		hotWalletId: request.SmartContractWallet.id,
	});
	const { wallet, utxos, address } = walletSession;
	if (utxos.length === 0) {
		throw new Error('No UTXOs found for the wallet');
	}
	const blockchainProvider = await createMeshProvider(paymentSource.PaymentSourceConfig.rpcProviderApiKey);
	const collateralCheck = await ensureCollateralReady({
		walletDbId: request.SmartContractWallet.id,
		walletAddress: address,
		meshWallet: wallet,
		utxos,
		blockchainProvider,
		network,
		serviceLabel: 'inbox-register-single',
	});
	if (collateralCheck.status === 'failed' && collateralCheck.reason === 'insufficient_funds') {
		// Wallet cannot fund the collateral prep tx for this attempt. Fail with a
		// clear reason (instead of silently deferring forever, which looks like
		// "stuck, nothing happens") so the request lands in RegistrationFailed, is
		// visible, and can be retried once the wallet is funded (recreate the
		// inbox registration). markRequestFailed unlocks the wallet on this
		// single-item terminal path.
		const failureMessage = `Wallet balance too low to fund the collateral preparation transaction: ${collateralCheck.details}. Top up the wallet with ADA and retry.`;
		await markRequestFailed(request, new Error(failureMessage));
		return;
	}
	if (collateralCheck.status === 'failed') {
		// reason === 'prep_tx_failed' (transient; wallet already unlocked). Bound
		// the retries so a deterministically-failing prep surfaces as
		// RegistrationFailed instead of looping forever.
		const reachedLimit = await recordInboxPrepFailure(request.id);
		if (reachedLimit) {
			await markRequestFailed(
				request,
				new Error(
					`Collateral preparation failed repeatedly (>= ${MAX_COLLATERAL_PREP_FAILURES} attempts): ${collateralCheck.details}. Check the wallet's UTxO set and retry.`,
				),
			);
		}
		return;
	}
	if (collateralCheck.status !== 'ready') {
		// status === 'deferred': a collateral prep tx is in flight; keep the
		// request queued so the next scheduler tick re-picks it up once the prep
		// tx confirms.
		return;
	}
	// Collateral ready — clear any transient prep-failure count.
	await resetInboxPrepFailureCount(request.id);
	const limitedFilteredUtxos = sortUtxosByLovelaceDesc(utxos);
	const firstUtxo = limitedFilteredUtxos[0];
	const collateralUtxo = limitedFilteredUtxos[0];
	const recipientWalletAddress = resolveRegistryRecipientWalletAddress(request);
	const fundingLovelace = resolveRegistryFundingLovelace(request);
	const assetName = generateRegistryAssetNameV2(firstUtxo);
	const metadata = buildInboxAgentMetadata({
		name: request.name,
		description: request.description,
		agentSlug: request.agentSlug,
		metadataVersion: request.metadataVersion ?? DEFAULTS.DEFAULT_METADATA_VERSION,
	});
	const rpcApiKey = paymentSource.PaymentSourceConfig.rpcProviderApiKey;

	const evaluationTx = await generateRegistryMintTransaction(
		blockchainProvider,
		network,
		script,
		address,
		recipientWalletAddress,
		fundingLovelace,
		validated.policyId,
		assetName,
		firstUtxo,
		collateralUtxo,
		limitedFilteredUtxos,
		metadata,
		undefined,
		rpcApiKey,
		// V2 single-item splitter — see authorize-refund/service.ts.
		WALLET_SPLITTER_LOVELACE,
	);
	const estimatedFee = (await blockchainProvider.evaluateTx(evaluationTx)) as Array<{
		budget: { mem: number; steps: number };
	}>;
	const unsignedTx = await generateRegistryMintTransaction(
		blockchainProvider,
		network,
		script,
		address,
		recipientWalletAddress,
		fundingLovelace,
		validated.policyId,
		assetName,
		firstUtxo,
		collateralUtxo,
		limitedFilteredUtxos,
		metadata,
		estimatedFee[0].budget,
		rpcApiKey,
		WALLET_SPLITTER_LOVELACE,
	);
	const signedTx = await wallet.signTx(unsignedTx, true);
	await prisma.inboxAgentRegistrationRequest.update({
		where: { id: request.id },
		data: {
			state: RegistrationState.RegistrationInitiated,
			...createPendingTransaction(request.SmartContractWallet.id),
		},
	});
	const newTxHash = await wallet.submitTx(signedTx);
	await walletSession.evaluateProjectedBalance(unsignedTx, limitedFilteredUtxos);
	await prisma.inboxAgentRegistrationRequest.update({
		where: { id: request.id },
		data: {
			agentIdentifier: validated.policyId + assetName,
			...updateCurrentTransactionHash(newTxHash),
		},
	});
	logger.debug(`Created V2 inbox agent registration transaction (single-item fallback):
              Tx ID: ${newTxHash}
              View on https://${network === 'preprod' ? 'preprod.' : ''}cardanoscan.io/transaction/${newTxHash}
          `);
}

export async function fallbackToSingleItems(
	validated: ValidatedInboxItem[],
	paymentSource: LockedPaymentSource,
	network: 'mainnet' | 'preprod',
	script: { version: LanguageVersion; code: string },
): Promise<void> {
	// Process AT MOST ONE item, not all N. Submitting the first item
	// creates a PendingTransaction that locks the hot wallet, so any
	// subsequent item in this tick would just race the wallet lock and
	// fail. The remaining items stay in their queued state — next
	// scheduler tick (after tx-sync clears the lock) re-picks them up
	// and batches them again. The fallback exists purely so a single
	// bad item (invalid datum, asset UTxO missing, etc.) does not block
	// the rest forever; it is NOT a parallel retry path. In the happy
	// path the batch builder above handles everything in one tx and
	// this function never runs.
	if (validated.length === 0) return;
	const v = validated[0];
	try {
		await advancedRetry({
			errorResolvers: [delayErrorResolver({ configuration: SERVICE_CONSTANTS.RETRY })],
			operation: async () => {
				await processSingleRegistration(v, paymentSource, network, script);
				return true;
			},
		});
	} catch (error) {
		await markRequestFailed(v.request, error);
	}
	// validated[1..] intentionally left untouched — they remain in
	// their `*Requested` state and the next tick (after the wallet
	// unlocks) will batch them again. Do NOT mark them failed: a batch
	// build failure caused by a transient issue (network blip,
	// cost-model sync race) is not a per-item failure and the items
	// deserve another chance.
}
