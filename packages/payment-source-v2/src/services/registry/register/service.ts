import { PaymentSourceType, RegistrationState, PricingType } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { convertNetwork } from '@/utils/converter/network-convert';
import { lockAndQueryRegistryRequests } from '@/utils/db/lock-and-query-registry-request';
import { DEFAULTS, SERVICE_CONSTANTS } from '@masumi/payment-core/config';
import { getRegistryScriptFromNetworkHandlerV2 } from '@/utils/generator/contract-generator';
import { stringToMetadata, cleanMetadata } from '@/utils/converter/metadata-string-convert';
import { advancedRetryAll, delayErrorResolver } from 'advanced-retry';
import { Mutex, MutexInterface, tryAcquire } from 'async-mutex';
import { interpretBlockchainError } from '@/utils/errors/blockchain-error-interpreter';
import { sortUtxosByLovelaceDesc } from '@/utils/utxo';
import { syncMeshCostModelsFromChain } from '@/utils/mesh-cost-model-sync';
import {
	createMeshProvider,
	createPendingTransaction,
	loadHotWalletSession,
	updateCurrentTransactionHash,
} from '@/services/shared';
import {
	generateRegistryAssetNameV2,
	generateRegistryMintTransaction,
	type RegistryMetadata,
	resolveRegistryFundingLovelace,
	resolveRegistryRecipientWalletAddress,
} from '@/services/registry/shared';
import { type SupportedPaymentSource } from '@/types/payment-source';

const mutex = new Mutex();

function validateRegistrationPricing(request: {
	Pricing: {
		pricingType: PricingType;
		FixedPricing: { Amounts: Array<{ unit: string; amount: bigint }> } | null;
	};
}): void {
	if (
		request.Pricing.pricingType != PricingType.Fixed &&
		request.Pricing.pricingType != PricingType.Free &&
		request.Pricing.pricingType != PricingType.Dynamic
	) {
		throw new Error('Unsupported pricing type: ' + String(request.Pricing.pricingType));
	}
	if (
		request.Pricing.pricingType == PricingType.Fixed &&
		(request.Pricing.FixedPricing == null || request.Pricing.FixedPricing.Amounts.length == 0)
	) {
		throw new Error('No fixed pricing found, this is likely a bug');
	}
	if (request.Pricing.pricingType != PricingType.Fixed && request.Pricing.FixedPricing != null) {
		throw new Error('Non-fixed pricing requires no fixed pricing to be set');
	}
}

function buildAgentMetadata(request: {
	name: string;
	description: string | null;
	apiBaseUrl: string | null;
	ExampleOutputs: Array<{ name: string; mimeType: string; url: string }>;
	capabilityName?: string | null;
	capabilityVersion?: string | null;
	authorName: string | null;
	authorContactEmail: string | null;
	authorContactOther: string | null;
	authorOrganization: string | null;
	privacyPolicy: string | null;
	terms: string | null;
	other: string | null;
	tags: string[];
	Pricing: {
		pricingType: PricingType;
		FixedPricing?: {
			Amounts: Array<{ unit: string; amount: bigint }>;
		} | null;
	};
	metadataVersion: number;
	SupportedPaymentSources: SupportedPaymentSource[];
}): RegistryMetadata {
	const supportedPaymentSources = request.SupportedPaymentSources.length > 0 ? request.SupportedPaymentSources : null;
	const metadata = {
		name: stringToMetadata(request.name),
		description: stringToMetadata(request.description),
		api_base_url: stringToMetadata(request.apiBaseUrl),
		example_output: request.ExampleOutputs.map((exampleOutput) => ({
			name: stringToMetadata(exampleOutput.name),
			mime_type: stringToMetadata(exampleOutput.mimeType),
			url: stringToMetadata(exampleOutput.url),
		})),
		capability:
			request.capabilityName && request.capabilityVersion
				? {
						name: stringToMetadata(request.capabilityName),
						version: stringToMetadata(request.capabilityVersion),
					}
				: undefined,
		author: {
			name: stringToMetadata(request.authorName),
			contact_email: stringToMetadata(request.authorContactEmail),
			contact_other: stringToMetadata(request.authorContactOther),
			organization: stringToMetadata(request.authorOrganization),
		},
		legal: {
			privacy_policy: stringToMetadata(request.privacyPolicy),
			terms: stringToMetadata(request.terms),
			other: stringToMetadata(request.other),
		},
		tags: request.tags,
		agentPricing:
			request.Pricing.pricingType == PricingType.Fixed
				? {
						pricingType: PricingType.Fixed,
						fixedPricing:
							request.Pricing.FixedPricing?.Amounts.map((pricing) => ({
								unit: stringToMetadata(pricing.unit),
								amount: pricing.amount.toString(),
							})) ?? [],
					}
				: {
						pricingType: request.Pricing.pricingType,
					},
		image: stringToMetadata(DEFAULTS.DEFAULT_IMAGE),
		metadata_version: request.metadataVersion.toString(),
		supported_payment_sources:
			request.metadataVersion >= DEFAULTS.DEFAULT_REGISTRY_METADATA_VERSION && supportedPaymentSources != null
				? supportedPaymentSources.map((source) => ({
						chain: stringToMetadata(source.chain),
						network: stringToMetadata(source.network),
						paymentSourceType: stringToMetadata(source.paymentSourceType),
						address: stringToMetadata(source.address),
					}))
				: undefined,
	};
	return cleanMetadata(metadata) as RegistryMetadata;
}

export async function registerAgentV2() {
	let release: MutexInterface.Releaser | null;
	try {
		release = await tryAcquire(mutex).acquire();
	} catch (e) {
		logger.info('Mutex timeout when locking', { error: e });
		return;
	}

	try {
		const paymentSourcesWithWalletLocked = await lockAndQueryRegistryRequests({
			state: RegistrationState.RegistrationRequested,
			maxBatchSize: 1,
			paymentSourceType: PaymentSourceType.Web3CardanoV2,
		});

		await Promise.allSettled(
			paymentSourcesWithWalletLocked.map(async (paymentSource) => {
				if (paymentSource.RegistryRequest.length === 0) return;
				logger.info(
					`Registering ${paymentSource.RegistryRequest.length} V2 agents for payment source ${paymentSource.id}`,
				);
				const network = convertNetwork(paymentSource.network);
				const registryRequests = paymentSource.RegistryRequest;
				if (registryRequests.length === 0) return;
				// Refresh mesh-sdk's bundled Plutus cost models from chain BEFORE
				// building any tx in this batch. Without this, mesh would hash the
				// transaction body against stale cost models and the ledger would
				// reject submission with PPViewHashesDontMatch. The helper is
				// memoized per-process, so this is a no-op within the TTL.
				await syncMeshCostModelsFromChain(paymentSource.PaymentSourceConfig.rpcProviderApiKey);
				const blockchainProvider = createMeshProvider(paymentSource.PaymentSourceConfig.rpcProviderApiKey);

				const results = await advancedRetryAll({
					errorResolvers: [delayErrorResolver({ configuration: SERVICE_CONSTANTS.RETRY })],
					operations: registryRequests.map((request) => async () => {
						validateRegistrationPricing(request);
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
						const { script, policyId } = await getRegistryScriptFromNetworkHandlerV2(paymentSource);

						const limitedFilteredUtxos = sortUtxosByLovelaceDesc(utxos);
						const firstUtxo = limitedFilteredUtxos[0];
						const collateralUtxo = limitedFilteredUtxos[0];
						const recipientWalletAddress = resolveRegistryRecipientWalletAddress(request);
						const fundingLovelace = resolveRegistryFundingLovelace(request);
						// V2 mint contract requires the structured asset name
						// [1B nonce>0x0f | 28B blake2b_224 | 3B version 0x000000] —
						// the V1 flat blake2b_256 layout would fail every check.
						const assetName = generateRegistryAssetNameV2(firstUtxo);
						const metadata = buildAgentMetadata(request);
						const rpcApiKey = paymentSource.PaymentSourceConfig.rpcProviderApiKey;

						const evaluationTx = await generateRegistryMintTransaction(
							blockchainProvider,
							network,
							script,
							address,
							recipientWalletAddress,
							fundingLovelace,
							policyId,
							assetName,
							firstUtxo,
							collateralUtxo,
							limitedFilteredUtxos,
							metadata,
							undefined,
							rpcApiKey,
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
							policyId,
							assetName,
							firstUtxo,
							collateralUtxo,
							limitedFilteredUtxos,
							metadata,
							estimatedFee[0].budget,
							rpcApiKey,
						);
						const signedTx = await wallet.signTx(unsignedTx, true);
						await prisma.registryRequest.update({
							where: { id: request.id },
							data: {
								state: RegistrationState.RegistrationInitiated,
								...createPendingTransaction(request.SmartContractWallet.id),
							},
						});
						const newTxHash = await wallet.submitTx(signedTx);
						await walletSession.evaluateProjectedBalance(unsignedTx, limitedFilteredUtxos);
						await prisma.registryRequest.update({
							where: { id: request.id },
							data: {
								agentIdentifier: policyId + assetName,
								...updateCurrentTransactionHash(newTxHash),
							},
						});
						logger.debug(`Created V2 register transaction:
              Tx ID: ${newTxHash}
              View on https://${network === 'preprod' ? 'preprod.' : ''}cardanoscan.io/transaction/${newTxHash}
          `);
						return true;
					}),
				});
				let index = 0;
				for (const result of results) {
					const request = registryRequests[index];
					if (result.success === false || result.result !== true) {
						const error = result.error;
						logger.error(`Error registering V2 agent ${request.id}`, { error });
						await prisma.registryRequest.update({
							where: { id: request.id },
							data: {
								state: RegistrationState.RegistrationFailed,
								error: interpretBlockchainError(error),
								SmartContractWallet: { update: { lockedAt: null } },
							},
						});
					}
					index++;
				}
			}),
		);
	} catch (error) {
		logger.error('Error registering V2 agents', { error });
	} finally {
		release();
	}
}
