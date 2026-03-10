import { TransactionStatus, RegistrationState, PricingType } from '@/generated/prisma/client';
import { prisma } from '@/utils/db';
import { BlockfrostProvider, IFetcher, LanguageVersion, MeshTxBuilder, Network, UTxO } from '@meshsdk/core';
import { logger } from '@/utils/logger';
import { convertNetwork } from '@/utils/converter/network-convert';
import { generateWalletExtended } from '@/utils/generator/wallet-generator';
import {
	lockAndQueryA2ARegistryRequests,
	lockAndQueryRegistryRequests,
} from '@/utils/db/lock-and-query-registry-request';
import { DEFAULTS, SERVICE_CONSTANTS } from '@/utils/config';
import { getRegistryScriptFromNetworkHandlerV1 } from '@/utils/generator/contract-generator';
import { blake2b } from 'ethereum-cryptography/blake2b';
import { stringToMetadata, cleanMetadata } from '@/utils/converter/metadata-string-convert';
import { advancedRetryAll, delayErrorResolver } from 'advanced-retry';
import { Mutex, MutexInterface, tryAcquire } from 'async-mutex';
import { errorToString } from '@/utils/converter/error-string-convert';
import { sortUtxosByLovelaceDesc } from '@/utils/utxo';

const mutex = new Mutex();

function validateRegistrationPricing(request: {
	Pricing: {
		pricingType: PricingType;
		FixedPricing: { Amounts: Array<{ [key: string]: unknown }> } | null;
	};
}): void {
	if (request.Pricing.pricingType != PricingType.Fixed && request.Pricing.pricingType != PricingType.Free) {
		throw new Error('Other than fixed and free pricing is not supported yet');
	}

	if (
		request.Pricing.pricingType == PricingType.Fixed &&
		(request.Pricing.FixedPricing == null || request.Pricing.FixedPricing.Amounts.length == 0)
	) {
		throw new Error('No fixed pricing found, this is likely a bug');
	}

	if (request.Pricing.pricingType == PricingType.Free && request.Pricing.FixedPricing != null) {
		throw new Error('Free pricing requires no fixed pricing to be set');
	}
}

function generateAssetName(firstUtxo: UTxO): string {
	const txId = firstUtxo.input.txHash;
	const txIndex = firstUtxo.input.outputIndex;
	const serializedOutput = txId + txIndex.toString(16).padStart(8, '0');

	const serializedOutputUint8Array = new Uint8Array(Buffer.from(serializedOutput.toString(), 'hex'));
	// Hash the serialized output using blake2b_256
	const blake2b256 = blake2b(serializedOutputUint8Array, 32);
	return Buffer.from(blake2b256).toString('hex');
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
			Amounts: Array<{ unit: string; amount: bigint; [key: string]: unknown }>;
		} | null;
	};
}): AgentMetadata {
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
						pricingType: PricingType.Free,
					},
		image: stringToMetadata(DEFAULTS.DEFAULT_IMAGE),
		metadata_version: DEFAULTS.DEFAULT_METADATA_VERSION.toString(),
	};
	// Clean undefined values from metadata - MeshSDK cannot serialize undefined
	return cleanMetadata(metadata) as AgentMetadata;
}

function buildAgentMetadataV2(request: {
	name: string;
	description: string | null;
	apiBaseUrl: string;
	agentCardUrl: string;
	a2aProtocolVersions: string[];
	tags: string[];
	metadataVersion: number;
}): AgentMetadata {
	return {
		name: stringToMetadata(request.name),
		api_url: stringToMetadata(request.apiBaseUrl),
		agent_card_url: stringToMetadata(request.agentCardUrl),
		a2a_protocol_versions: request.a2aProtocolVersions,
		metadata_version: request.metadataVersion.toString(),
		...(request.description ? { description: stringToMetadata(request.description) } : {}),
		...(request.tags.length > 0 ? { tags: request.tags } : {}),
		image: stringToMetadata(DEFAULTS.DEFAULT_IMAGE),
	};
}

async function processRegistrationRequests(
	paymentSource: Awaited<ReturnType<typeof lockAndQueryRegistryRequests>>[number],
) {
	if (paymentSource.RegistryRequest.length === 0) return;

	logger.info(`Registering ${paymentSource.RegistryRequest.length} agents for payment source ${paymentSource.id}`);

	const network = convertNetwork(paymentSource.network);
	const blockchainProvider = new BlockfrostProvider(paymentSource.PaymentSourceConfig.rpcProviderApiKey);

	const results = await advancedRetryAll({
		errorResolvers: [delayErrorResolver({ configuration: SERVICE_CONSTANTS.RETRY })],
		operations: paymentSource.RegistryRequest.map((request) => async () => {
			validateRegistrationPricing(request);
			const { wallet, utxos, address } = await generateWalletExtended(
				paymentSource.network,
				paymentSource.PaymentSourceConfig.rpcProviderApiKey,
				request.SmartContractWallet.Secret.encryptedMnemonic,
			);
			if (utxos.length === 0) throw new Error('No UTXOs found for the wallet');

			const { script, policyId } = await getRegistryScriptFromNetworkHandlerV1(paymentSource);
			const limitedFilteredUtxos = sortUtxosByLovelaceDesc(utxos);
			const firstUtxo = limitedFilteredUtxos[0];
			const collateralUtxo = limitedFilteredUtxos[0];
			const assetName = generateAssetName(firstUtxo);

			const metadata = buildAgentMetadata(request);

			const evaluationTx = await generateRegisterAgentTransaction(
				blockchainProvider,
				network,
				script,
				address,
				policyId,
				assetName,
				firstUtxo,
				collateralUtxo,
				limitedFilteredUtxos,
				metadata,
			);
			const estimatedFee = (await blockchainProvider.evaluateTx(evaluationTx)) as Array<{
				budget: { mem: number; steps: number };
			}>;
			if (estimatedFee.length === 0) {
				throw new Error('Transaction evaluation returned no budget estimates');
			}
			const unsignedTx = await generateRegisterAgentTransaction(
				blockchainProvider,
				network,
				script,
				address,
				policyId,
				assetName,
				firstUtxo,
				collateralUtxo,
				limitedFilteredUtxos,
				metadata,
				estimatedFee[0].budget,
			);

			const signedTx = await wallet.signTx(unsignedTx, true);
			await prisma.registryRequest.update({
				where: { id: request.id },
				data: {
					state: RegistrationState.RegistrationInitiated,
					CurrentTransaction: {
						create: {
							txHash: null,
							status: TransactionStatus.Pending,
							BlocksWallet: { connect: { id: request.SmartContractWallet.id } },
						},
					},
				},
			});

			const newTxHash = await wallet.submitTx(signedTx);
			await prisma.registryRequest.update({
				where: { id: request.id },
				data: {
					agentIdentifier: policyId + assetName,
					CurrentTransaction: { update: { txHash: newTxHash } },
				},
			});
			logger.debug(
				`Created registration transaction: ${newTxHash} — https://${network === 'preprod' ? 'preprod.' : ''}cardanoscan.io/transaction/${newTxHash}`,
			);
			return true;
		}),
	});

	let index = 0;
	for (const result of results) {
		const request = paymentSource.RegistryRequest[index];
		if (result.success === false || result.result !== true) {
			logger.error(`Error registering agent ${request.id}`, { error: result.error });
			await prisma.registryRequest.update({
				where: { id: request.id },
				data: {
					state: RegistrationState.RegistrationFailed,
					error: errorToString(result.error),
					SmartContractWallet: { update: { lockedAt: null } },
				},
			});
		}
		index++;
	}
}

async function processA2ARegistrationRequests(
	paymentSource: Awaited<ReturnType<typeof lockAndQueryA2ARegistryRequests>>[number],
) {
	if (paymentSource.A2ARegistryRequest.length === 0) return;

	logger.info(
		`Registering ${paymentSource.A2ARegistryRequest.length} A2A agents for payment source ${paymentSource.id}`,
	);

	const network = convertNetwork(paymentSource.network);
	const blockchainProvider = new BlockfrostProvider(paymentSource.PaymentSourceConfig.rpcProviderApiKey);

	const results = await advancedRetryAll({
		errorResolvers: [delayErrorResolver({ configuration: SERVICE_CONSTANTS.RETRY })],
		operations: paymentSource.A2ARegistryRequest.map((request) => async () => {
			validateRegistrationPricing(request);
			const { wallet, utxos, address } = await generateWalletExtended(
				paymentSource.network,
				paymentSource.PaymentSourceConfig.rpcProviderApiKey,
				request.SmartContractWallet.Secret.encryptedMnemonic,
			);
			if (utxos.length === 0) throw new Error('No UTXOs found for the wallet');

			const { script, policyId } = await getRegistryScriptFromNetworkHandlerV1(paymentSource);
			const limitedFilteredUtxos = sortUtxosByLovelaceDesc(utxos);
			const firstUtxo = limitedFilteredUtxos[0];
			const collateralUtxo = limitedFilteredUtxos[0];
			const assetName = generateAssetName(firstUtxo);

			const metadata = buildAgentMetadataV2({
				name: request.name,
				description: request.description,
				apiBaseUrl: request.apiBaseUrl,
				agentCardUrl: request.agentCardUrl,
				a2aProtocolVersions: request.a2aProtocolVersions,
				tags: request.tags,
				metadataVersion: DEFAULTS.A2A_METADATA_VERSION,
			});

			const evaluationTx = await generateRegisterAgentTransaction(
				blockchainProvider,
				network,
				script,
				address,
				policyId,
				assetName,
				firstUtxo,
				collateralUtxo,
				limitedFilteredUtxos,
				metadata,
			);
			const estimatedFee = (await blockchainProvider.evaluateTx(evaluationTx)) as Array<{
				budget: { mem: number; steps: number };
			}>;
			if (estimatedFee.length === 0) {
				throw new Error('Transaction evaluation returned no budget estimates');
			}
			const unsignedTx = await generateRegisterAgentTransaction(
				blockchainProvider,
				network,
				script,
				address,
				policyId,
				assetName,
				firstUtxo,
				collateralUtxo,
				limitedFilteredUtxos,
				metadata,
				estimatedFee[0].budget,
			);

			const signedTx = await wallet.signTx(unsignedTx, true);
			await prisma.a2ARegistryRequest.update({
				where: { id: request.id },
				data: {
					state: RegistrationState.RegistrationInitiated,
					CurrentTransaction: {
						create: {
							txHash: null,
							status: TransactionStatus.Pending,
							BlocksWallet: { connect: { id: request.SmartContractWallet.id } },
						},
					},
				},
			});

			const newTxHash = await wallet.submitTx(signedTx);
			await prisma.a2ARegistryRequest.update({
				where: { id: request.id },
				data: {
					agentIdentifier: policyId + assetName,
					CurrentTransaction: { update: { txHash: newTxHash } },
				},
			});
			logger.debug(
				`Created A2A registration transaction: ${newTxHash} — https://${network === 'preprod' ? 'preprod.' : ''}cardanoscan.io/transaction/${newTxHash}`,
			);
			return true;
		}),
	});

	let index = 0;
	for (const result of results) {
		const request = paymentSource.A2ARegistryRequest[index];
		if (result.success === false || result.result !== true) {
			logger.error(`Error registering A2A agent ${request.id}`, { error: result.error });
			await prisma.a2ARegistryRequest.update({
				where: { id: request.id },
				data: {
					state: RegistrationState.RegistrationFailed,
					error: errorToString(result.error),
					SmartContractWallet: { update: { lockedAt: null } },
				},
			});
		}
		index++;
	}
}

export async function registerAgentV1() {
	let release: MutexInterface.Releaser | null;
	try {
		release = await tryAcquire(mutex).acquire();
	} catch (e) {
		logger.info('Mutex timeout when locking', { error: e });
		return;
	}

	try {
		const [standardSources, a2aSources] = await Promise.all([
			lockAndQueryRegistryRequests({ state: RegistrationState.RegistrationRequested, maxBatchSize: 1 }),
			lockAndQueryA2ARegistryRequests({ state: RegistrationState.RegistrationRequested, maxBatchSize: 1 }),
		]);

		await Promise.allSettled([
			...standardSources.map(processRegistrationRequests),
			...a2aSources.map(processA2ARegistrationRequests),
		]);
	} catch (error) {
		logger.error('Error submitting result', { error: error });
	} finally {
		release();
	}
}

type AgentMetadata = {
	[key: string]: string | string[] | AgentMetadata | AgentMetadata[] | undefined;
};

async function generateRegisterAgentTransaction(
	blockchainProvider: IFetcher,
	network: Network,
	script: {
		version: LanguageVersion;
		code: string;
	},
	walletAddress: string,
	policyId: string,
	assetName: string,
	firstUtxo: UTxO,
	collateralUtxo: UTxO,
	utxos: UTxO[],
	metadata: AgentMetadata,
	exUnits: {
		mem: number;
		steps: number;
	} = SERVICE_CONSTANTS.SMART_CONTRACT.defaultExUnits,
) {
	const txBuilder = new MeshTxBuilder({
		fetcher: blockchainProvider,
	});
	const deserializedAddress = txBuilder.serializer.deserializer.key.deserializeAddress(walletAddress);
	//setup minting data separately as the minting function does not work well with hex encoded strings without some magic
	txBuilder
		.txIn(firstUtxo.input.txHash, firstUtxo.input.outputIndex)
		.mintPlutusScript(script.version)
		.mint('1', policyId, assetName)
		.mintingScript(script.code)
		.mintRedeemerValue({ alternative: 0, fields: [] }, 'Mesh', exUnits)
		.metadataValue(SERVICE_CONSTANTS.METADATA.nftLabel, {
			[policyId]: {
				[assetName]: metadata,
			},
			version: '1',
		})
		.txIn(collateralUtxo.input.txHash, collateralUtxo.input.outputIndex)
		.txInCollateral(collateralUtxo.input.txHash, collateralUtxo.input.outputIndex)
		.setTotalCollateral(SERVICE_CONSTANTS.SMART_CONTRACT.collateralAmount)
		.txOut(walletAddress, [
			{
				unit: policyId + assetName,
				quantity: SERVICE_CONSTANTS.SMART_CONTRACT.mintQuantity,
			},
			{
				unit: SERVICE_CONSTANTS.CARDANO.NATIVE_TOKEN,
				quantity: SERVICE_CONSTANTS.SMART_CONTRACT.collateralAmount,
			},
		]);
	for (const utxo of utxos) {
		txBuilder.txIn(utxo.input.txHash, utxo.input.outputIndex);
	}
	return await txBuilder
		.requiredSignerHash(deserializedAddress.pubKeyHash)
		.setNetwork(network)
		.metadataValue(SERVICE_CONSTANTS.METADATA.masumiLabel, {
			msg: ['Masumi', 'RegisterAgent'],
		})
		.changeAddress(walletAddress)
		.complete();
}
