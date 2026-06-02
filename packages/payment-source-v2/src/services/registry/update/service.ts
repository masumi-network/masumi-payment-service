import { PaymentSourceType, RegistrationState } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import type { LanguageVersion } from '@meshsdk/core';
import { convertNetwork } from '@/utils/converter/network-convert';
import { lockAndQueryRegistryRequests } from '@/utils/db/lock-and-query-registry-request';
import { retryOnSerializationConflict } from '@/utils/db/retry';
import { SERVICE_CONSTANTS } from '@masumi/payment-core/config';
import { getRegistryScriptFromNetworkHandlerV2 } from '@/utils/generator/contract-generator';
import { advancedRetry, delayErrorResolver } from 'advanced-retry';
import { Mutex, MutexInterface, tryAcquire } from 'async-mutex';
import { interpretBlockchainError } from '@/utils/errors/blockchain-error-interpreter';
import { extractAssetName, extractPolicyId } from '@/utils/converter/agent-identifier';
import { sortAndLimitUtxos } from '@/utils/utxo';
import { createMeshProvider, createPendingTransaction, loadHotWalletSession } from '@/services/shared';
import {
	bumpRegistryAssetNameVersionV2,
	findRegistryTokenUtxo,
	generateRegistryUpdateTransactionAutomaticFees,
	resolveRegistryDeregistrationWallet,
	resolveRegistryFundingLovelace,
} from '@/services/registry/shared';
import { WALLET_SPLITTER_LOVELACE } from '../../../builders/batch-helpers';
import { ensureCollateralReady } from '../../wallet-collateral/ensure-collateral-ready';
import { buildAgentMetadata, validateRegistrationPricing } from '../register/service';
import type { RegistryMetadataPaymentSource } from '@/types/payment-source';

// Update is a per-asset action (one shared MINT redeemer covers a single
// burn+mint pair); throughput is bounded by chain confirmation time, not
// batch sizing. Process one request per tick.
const REGISTRY_BATCH_SIZE = 1;

const mutex = new Mutex();

type LockedPaymentSource = Awaited<ReturnType<typeof lockAndQueryRegistryRequests>>[number];
type RegistryRequestRecord = LockedPaymentSource['RegistryRequest'][number];

async function markRequestFailed(request: RegistryRequestRecord, error: unknown): Promise<void> {
	const walletToUnlock = request.DeregistrationHotWallet ?? request.SmartContractWallet;
	logger.error(`Error updating V2 agent ${request.id}`, { error });
	await prisma.registryRequest.update({
		where: { id: request.id },
		data: {
			state: RegistrationState.UpdateFailed,
			error: interpretBlockchainError(error),
		},
	});
	try {
		await prisma.hotWallet.update({
			where: { id: walletToUnlock.id, deletedAt: null },
			data: { lockedAt: null },
		});
	} catch (unlockError) {
		logger.warn(
			'V2 update markRequestFailed: request failure stamped but hot wallet unlock failed; wallet may remain locked for up to 30min until wallet-timeouts sweeps',
			{
				requestId: request.id,
				hotWalletId: walletToUnlock.id,
				error:
					unlockError instanceof Error
						? { message: unlockError.message, stack: unlockError.stack, name: unlockError.name }
						: unlockError,
			},
		);
	}
}

async function processUpdate(
	request: RegistryRequestRecord,
	paymentSource: LockedPaymentSource,
	network: 'mainnet' | 'preprod',
	script: { version: LanguageVersion; code: string },
	policyId: string,
): Promise<void> {
	if (!request.agentIdentifier) {
		throw new Error('Agent identifier is required for update');
	}
	validateRegistrationPricing(request);

	const oldAssetName = extractAssetName(request.agentIdentifier);
	const oldPolicyId = extractPolicyId(request.agentIdentifier);
	if (oldPolicyId !== policyId) {
		throw new Error('agentIdentifier policy does not match payment source script');
	}
	const newAssetName = bumpRegistryAssetNameVersionV2(oldAssetName);
	const newAgentIdentifier = policyId + newAssetName;

	const holderWallet = resolveRegistryDeregistrationWallet(request);
	const walletSession = await loadHotWalletSession({
		network: paymentSource.network,
		rpcProviderApiKey: paymentSource.PaymentSourceConfig.rpcProviderApiKey,
		encryptedMnemonic: holderWallet.Secret.encryptedMnemonic,
		hotWalletId: holderWallet.id,
	});
	const { wallet, utxos, address } = walletSession;
	if (utxos.length === 0) {
		throw new Error('No UTXOs found for the wallet');
	}
	const blockchainProvider = await createMeshProvider(paymentSource.PaymentSourceConfig.rpcProviderApiKey);
	const collateralCheck = await ensureCollateralReady({
		walletDbId: holderWallet.id,
		walletAddress: address,
		meshWallet: wallet,
		utxos,
		blockchainProvider,
		network,
		serviceLabel: 'registry-update',
	});
	if (collateralCheck.status !== 'ready') {
		// Defer this tick — collateral helper has already logged. Returning
		// keeps the row queued; the next scheduler tick re-picks it up after
		// the prep tx confirms (mirrors register/deregister single-item).
		return;
	}

	// Holder-holds-asset guard: findRegistryTokenUtxo throws if the resolved
	// holder wallet's UTxOs no longer contain this asset. The UpdateAction tx
	// is signed by `holderWallet` (the on-chain holder recorded at request
	// time), so if the asset has since moved out of that managed wallet there is
	// nothing to burn+remint and the tx would fail on chain anyway — fail fast
	// here with a clear message instead.
	const tokenUtxo = findRegistryTokenUtxo(utxos, request.agentIdentifier);
	const limitedFilteredUtxos = sortAndLimitUtxos(utxos, 8_000_000);
	const collateralUtxo = limitedFilteredUtxos[0];
	if (collateralUtxo == null) {
		throw new Error('Collateral UTXO not found');
	}

	const paymentSourceMetadata: RegistryMetadataPaymentSource = {
		network: paymentSource.network,
		paymentSourceType: paymentSource.paymentSourceType,
		smartContractAddress: paymentSource.smartContractAddress,
	};
	const metadata = buildAgentMetadata(request, paymentSourceMetadata);

	// Default the version-bumped NFT recipient to the CURRENT HOLDER (`address`,
	// the wallet that signs this tx), NOT request.SmartContractWallet. When the
	// holder differs from SmartContractWallet (the common case — the route
	// records the on-chain holder as DeregistrationHotWallet), sending the new
	// asset to SmartContractWallet would silently migrate the registry NFT to a
	// different wallet on every default update. An explicit caller-supplied
	// RecipientWallet still overrides.
	const recipientWalletAddress = request.RecipientWallet?.walletAddress ?? address;
	const fundingLovelace = resolveRegistryFundingLovelace(request);

	const unsignedTx = await generateRegistryUpdateTransactionAutomaticFees(
		blockchainProvider,
		network,
		script,
		address,
		recipientWalletAddress,
		fundingLovelace,
		policyId,
		oldAssetName,
		newAssetName,
		tokenUtxo,
		collateralUtxo,
		limitedFilteredUtxos,
		metadata,
		paymentSource.PaymentSourceConfig.rpcProviderApiKey,
		WALLET_SPLITTER_LOVELACE,
	);
	const signedTx = await wallet.signTx(unsignedTx, true);

	// Submit FIRST, then write DB. Same rationale as
	// register/deregister single-item: on submit failure there is no
	// orphan Transaction row to clean up, and we revert state back to
	// UpdateRequested so the next tick can retry.
	let newTxHash: string;
	try {
		newTxHash = await wallet.submitTx(signedTx);
	} catch (error) {
		logger.error('Error submitting V2 update tx', { error, requestId: request.id });
		await prisma.registryRequest.update({
			where: { id: request.id },
			data: {
				state: RegistrationState.UpdateRequested,
				DeregistrationHotWallet: {
					update: { lockedAt: null },
				},
			},
		});
		return;
	}

	await walletSession.evaluateProjectedBalance(unsignedTx, limitedFilteredUtxos);

	// Atomic flip: new asset identifier replaces the old, state advances to
	// UpdateInitiated, shared Tx row is attached. tx-sync then verifies the
	// new asset on chain.
	await retryOnSerializationConflict(
		() =>
			prisma.registryRequest.update({
				where: { id: request.id },
				data: {
					state: RegistrationState.UpdateInitiated,
					agentIdentifier: newAgentIdentifier,
					...createPendingTransaction(holderWallet.id, newTxHash),
				},
			}),
		{ label: 'v2-update-post-submit' },
	);
	logger.debug(`Created V2 update transaction:
              Tx ID: ${newTxHash}
              View on https://${network === 'preprod' ? 'preprod.' : ''}cardanoscan.io/transaction/${newTxHash}
          `);
}

export async function updateAgentV2() {
	let release: MutexInterface.Releaser | null;
	try {
		release = await tryAcquire(mutex).acquire();
	} catch (e) {
		logger.info('Mutex timeout when locking', { error: e });
		return;
	}

	try {
		const paymentSourcesWithWalletLocked = await lockAndQueryRegistryRequests({
			state: RegistrationState.UpdateRequested,
			maxBatchSize: REGISTRY_BATCH_SIZE,
			paymentSourceType: PaymentSourceType.Web3CardanoV2,
		});

		await Promise.allSettled(
			paymentSourcesWithWalletLocked.map(async (paymentSource) => {
				if (paymentSource.RegistryRequest.length === 0) return;
				logger.info(
					`Updating ${paymentSource.RegistryRequest.length} V2 agent registrations for payment source ${paymentSource.id}`,
				);
				const network = convertNetwork(paymentSource.network);
				const { script, policyId } = await getRegistryScriptFromNetworkHandlerV2(paymentSource);

				for (const request of paymentSource.RegistryRequest) {
					try {
						await advancedRetry({
							errorResolvers: [delayErrorResolver({ configuration: SERVICE_CONSTANTS.RETRY })],
							operation: async () => {
								await processUpdate(request, paymentSource, network, script, policyId);
								return true;
							},
						});
					} catch (error) {
						await markRequestFailed(request, error);
					}
				}
			}),
		);
	} catch (error) {
		logger.error('Error updating V2 agent registrations', { error });
	} finally {
		release?.();
	}
}
