import { PaymentSourceType, RegistrationState, PricingType } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { convertNetwork } from '@masumi/payment-core/network';
// TODO(v1-package-boundary): move lock-and-query-registry-request, contract-generator, metadata-string-convert, blockchain-error-interpreter, utxo to @masumi/payment-core
import { lockAndQueryRegistryRequests } from '@/utils/db/lock-and-query-registry-request';
import { DEFAULTS, SERVICE_CONSTANTS } from '@masumi/payment-core/config';
import { getRegistryScriptFromNetworkHandlerV1 } from '@/utils/generator/contract-generator';
import { stringToMetadata, cleanMetadata } from '@/utils/converter/metadata-string-convert';
import { advancedRetryAll, delayErrorResolver } from 'advanced-retry';
import { Mutex, MutexInterface, tryAcquire } from 'async-mutex';
import { interpretBlockchainError } from '@masumi/payment-core/blockchain-error-interpreter';
import { sortUtxosByLovelaceDesc } from '@/utils/utxo';
import {
	createMeshProvider,
	createPendingTransaction,
	loadHotWalletSession,
	updateCurrentTransactionHash,
} from '@/services/shared';
import {
	generateRegistryAssetName,
	generateRegistryMintTransaction,
	type RegistryMetadata,
	resolveRegistryFundingLovelace,
	resolveRegistryRecipientWalletAddress,
} from '@/services/registry/shared';
import { verificationRowToApi, verificationsToMetadata, type AgentVerificationRow } from '@/types/verification';

const mutex = new Mutex();

type RegistrySupportedPaymentSourceMetadataRow = {
	chain: string;
	network: string;
	paymentSourceType: PaymentSourceType | null;
	address: string;
	payTo?: string | null;
};

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

export function buildAgentMetadata(request: {
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
	SupportedPaymentSources: RegistrySupportedPaymentSourceMetadataRow[];
	// Persisted AgentVerification rows; reshaped to nested form before emit.
	Verifications?: AgentVerificationRow[];
}): RegistryMetadata {
	if (request.metadataVersion !== DEFAULTS.DEFAULT_METADATA_VERSION) {
		throw new Error(`V1 registry requests require metadata version ${DEFAULTS.DEFAULT_METADATA_VERSION}`);
	}
	if (request.SupportedPaymentSources.length > 0) {
		throw new Error('V1 registry requests must not contain supported payment sources');
	}
	// Optional KERI/Veridian verification claims (see @masumi/payment-core/
	// verification). Gated on the same metadata version as supported_payment_sources
	// (a v2-metadata concept); self-describing on chain for third-party verification.
	const verificationRows = request.Verifications ?? [];
	const verificationsMetadata =
		request.metadataVersion >= DEFAULTS.DEFAULT_REGISTRY_METADATA_VERSION && verificationRows.length > 0
			? verificationsToMetadata(verificationRows.map(verificationRowToApi), stringToMetadata)
			: undefined;
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
		// V1 (legacy) registries keep the top-level agentPricing block. Only V2
		// drops it in favour of the per-source pricing folded into each Cardano
		// supported payment source.
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
		verifications: verificationsMetadata,
	};
	return cleanMetadata(metadata) as RegistryMetadata;
}

export async function registerAgentV1() {
	let release: MutexInterface.Releaser | null;
	try {
		release = await tryAcquire(mutex).acquire();
	} catch {
		logger.info('registry_register_v1 is already running, skipping cycle');
		return;
	}

	try {
		const paymentSourcesWithWalletLocked = await lockAndQueryRegistryRequests({
			state: RegistrationState.RegistrationRequested,
			maxBatchSize: 1,
			paymentSourceType: PaymentSourceType.Web3CardanoV1,
		});

		await Promise.allSettled(
			paymentSourcesWithWalletLocked.map(async (paymentSource) => {
				if (paymentSource.RegistryRequest.length === 0) return;
				logger.info(
					`Registering ${paymentSource.RegistryRequest.length} V1 agents for payment source ${paymentSource.id}`,
				);
				const network = convertNetwork(paymentSource.network);
				const registryRequests = paymentSource.RegistryRequest;
				if (registryRequests.length === 0) return;
				// `createMeshProvider` ALSO refreshes mesh-sdk's bundled Plutus
				// cost models from chain via Blockfrost, working around an
				// upstream gap that otherwise causes `PPViewHashesDontMatch` on
				// submit when chain cost models have rotated past the SDK's
				// bundled defaults. See src/utils/mesh-cost-model-sync.
				const blockchainProvider = await createMeshProvider(paymentSource.PaymentSourceConfig.rpcProviderApiKey);

				const results = await advancedRetryAll({
					errorResolvers: [delayErrorResolver({ configuration: SERVICE_CONSTANTS.RETRY })],
					operations: registryRequests.map((request) => async () => {
						if (request.Pricing == null) {
							throw new Error('V1 registry request is missing top-level AgentPricing');
						}
						const requestWithPricing = { ...request, Pricing: request.Pricing };
						validateRegistrationPricing(requestWithPricing);
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
						const { script, policyId } = await getRegistryScriptFromNetworkHandlerV1(paymentSource);

						const limitedFilteredUtxos = sortUtxosByLovelaceDesc(utxos);
						const firstUtxo = limitedFilteredUtxos[0];
						const collateralUtxo = limitedFilteredUtxos[0];
						const recipientWalletAddress = resolveRegistryRecipientWalletAddress(request);
						const fundingLovelace = resolveRegistryFundingLovelace(request);
						const assetName = generateRegistryAssetName(firstUtxo);
						const metadata = buildAgentMetadata(requestWithPricing);
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
						logger.debug(`Created V1 register transaction:
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
						logger.error(`Error registering V1 agent ${request.id}`, { error });
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
		logger.error('Error registering V1 agents', { error });
	} finally {
		release?.();
	}
}
