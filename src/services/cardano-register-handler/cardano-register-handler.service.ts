import { TransactionStatus, RegistrationState, PricingType } from '@/generated/prisma/client';
import { prisma } from '@/utils/db';
import { BlockfrostProvider, IFetcher, LanguageVersion, MeshTxBuilder, Network, UTxO } from '@meshsdk/core';
import { logger } from '@/utils/logger';
import { convertNetwork } from '@/utils/converter/network-convert';
import { generateWalletExtended } from '@/utils/generator/wallet-generator';
import { lockAndQueryRegistryRequests } from '@/utils/db/lock-and-query-registry-request';
import { DEFAULTS, SERVICE_CONSTANTS } from '@/utils/config';
import { getRegistryScriptFromNetworkHandlerV1 } from '@/utils/generator/contract-generator';
import { blake2b } from 'ethereum-cryptography/blake2b';
import { stringToMetadata, cleanMetadata } from '@/utils/converter/metadata-string-convert';
import { advancedRetryAll, delayErrorResolver } from 'advanced-retry';
import { Mutex, MutexInterface, tryAcquire } from 'async-mutex';
import { errorToString } from '@/utils/converter/error-string-convert';
import { sortUtxosByLovelaceDesc, sortAndLimitUtxos } from '@/utils/utxo';
import {
	walletLowBalanceMonitorService,
	toBalanceMapFromMeshUtxos,
	type MeshLikeUtxo,
} from '@/services/wallet-low-balance-monitor';
import { getBlockfrostInstance } from '@/utils/blockfrost';

const mutex = new Mutex();

/** Minimum lovelace in a single UTXO to attempt a split (2×2 ADA outputs + fee buffer) */
const MIN_LOVELACE_FOR_SPLIT = 4_500_000;

/** Poll interval and max wait for split tx confirmation */
const SPLIT_TX_POLL_MS = 3000;
const SPLIT_TX_MAX_WAIT_MS = 120_000;

function getLovelaceFromUtxo(utxo: UTxO): number {
	return parseInt(utxo.output.amount.find((a) => a.unit === 'lovelace' || a.unit === '')?.quantity ?? '0');
}

function isLovelaceOnlyUtxo(utxo: UTxO): boolean {
	return utxo.output.amount.every((a) => a.unit === 'lovelace' || a.unit === '');
}

async function waitForTxConfirmation(
	txHash: string,
	blockfrost: ReturnType<typeof getBlockfrostInstance>,
): Promise<void> {
	const deadline = Date.now() + SPLIT_TX_MAX_WAIT_MS;
	while (Date.now() < deadline) {
		const tx = await blockfrost.txs(txHash);
		if (tx.block != null) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, SPLIT_TX_POLL_MS));
	}
	throw new Error(`Split transaction ${txHash} did not confirm within ${SPLIT_TX_MAX_WAIT_MS / 1000}s`);
}

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
	metadataVersion: number;
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
		metadata_version: request.metadataVersion.toString(),
	};
	// Clean undefined values from metadata - MeshSDK cannot serialize undefined
	return cleanMetadata(metadata) as AgentMetadata;
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
		//Submit a result for invalid tokens
		const paymentSourcesWithWalletLocked = await lockAndQueryRegistryRequests({
			state: RegistrationState.RegistrationRequested,
			maxBatchSize: 1,
		});

		await Promise.allSettled(
			paymentSourcesWithWalletLocked.map(async (paymentSource) => {
				if (paymentSource.RegistryRequest.length === 0) return;

				logger.info(
					`Registering ${paymentSource.RegistryRequest.length} agents for payment source ${paymentSource.id}`,
				);

				const network = convertNetwork(paymentSource.network);

				const registryRequests = paymentSource.RegistryRequest;

				if (registryRequests.length === 0) return;

				const blockchainProvider = new BlockfrostProvider(paymentSource.PaymentSourceConfig.rpcProviderApiKey);

				const results = await advancedRetryAll({
					errorResolvers: [
						delayErrorResolver({
							configuration: SERVICE_CONSTANTS.RETRY,
						}),
					],
					operations: registryRequests.map((request) => async () => {
						logger.info('[register] start', {
							requestId: request.id,
							walletId: request.SmartContractWallet.id,
						});
						validateRegistrationPricing(request);
						const { wallet, utxos, address } = await generateWalletExtended(
							paymentSource.network,
							paymentSource.PaymentSourceConfig.rpcProviderApiKey,
							request.SmartContractWallet.Secret.encryptedMnemonic,
						);
						logger.info('[register] utxos fetched', {
							requestId: request.id,
							utxoCount: utxos.length,
						});
						await walletLowBalanceMonitorService.evaluateHotWalletById(
							request.SmartContractWallet.id,
							toBalanceMapFromMeshUtxos(utxos as MeshLikeUtxo[]),
							'submission',
						);

						if (utxos.length === 0) {
							throw new Error('No UTXOs found for the wallet');
						}

						const { script, policyId } = await getRegistryScriptFromNetworkHandlerV1(paymentSource);
						let currentUtxos = utxos;

						// Ensure 2+ UTXOs (collateral and inputs must be disjoint). Auto-split if possible.
						while (true) {
							let limitedUtxos;
							try {
								limitedUtxos = sortAndLimitUtxos(
									currentUtxos,
									8_000_000,
									SERVICE_CONSTANTS.SMART_CONTRACT.minSellingWalletUtxoLovelace,
									2, // min 2 UTxOs: collateral and inputs must be disjoint
								);
							} catch (utxoErr) {
								logger.error('[register] sortAndLimitUtxos failed', {
									requestId: request.id,
									utxoCount: currentUtxos.length,
									error: errorToString(utxoErr),
								});
								throw utxoErr;
							}
							logger.info('[register] utxos limited', {
								requestId: request.id,
								limitedCount: limitedUtxos.length,
							});

							if (limitedUtxos.length >= 2) {
								break;
							}

							// Need 2 UTXOs but only have 1 (or filtered to 1). Attempt split if feasible.
							const singleUtxo = currentUtxos.find((u) => getLovelaceFromUtxo(u) >= 2_000_000);
							const singleUtxoLovelace = singleUtxo != null ? getLovelaceFromUtxo(singleUtxo) : 0;
							if (singleUtxo != null && singleUtxoLovelace >= MIN_LOVELACE_FOR_SPLIT) {
								logger.info('[register] splitting single UTXO for collateral/input disjointness', {
									requestId: request.id,
									lovelace: singleUtxoLovelace,
									hasTokens: !isLovelaceOnlyUtxo(singleUtxo),
								});
								const txBuilder = new MeshTxBuilder({
									fetcher: blockchainProvider,
								});
								// 1 input → 2 outputs: 2 ADA + change (each output must be ≥2 ADA)
								const splitOutputLovelace = SERVICE_CONSTANTS.SMART_CONTRACT.minNftOutputLovelace;
								const unsignedSplit = await txBuilder
									.txIn(singleUtxo.input.txHash, singleUtxo.input.outputIndex)
									.txOut(address, [{ unit: SERVICE_CONSTANTS.CARDANO.NATIVE_TOKEN, quantity: splitOutputLovelace }])
									.changeAddress(address)
									.setNetwork(network)
									.complete();
								const signedSplit = await wallet.signTx(unsignedSplit, true);
								const splitTxHash = await wallet.submitTx(signedSplit);
								logger.info('[register] split tx submitted', {
									requestId: request.id,
									txHash: splitTxHash,
								});
								const blockfrost = getBlockfrostInstance(
									paymentSource.network,
									paymentSource.PaymentSourceConfig.rpcProviderApiKey,
								);
								await waitForTxConfirmation(splitTxHash, blockfrost);
								logger.info('[register] split tx confirmed, refetching UTXOs', {
									requestId: request.id,
								});
								const refreshed = await generateWalletExtended(
									paymentSource.network,
									paymentSource.PaymentSourceConfig.rpcProviderApiKey,
									request.SmartContractWallet.Secret.encryptedMnemonic,
								);
								currentUtxos = refreshed.utxos;
								continue;
							}

							throw new Error(
								'Registration requires at least 2 UTxOs (one for collateral, one for inputs). ' +
									'Each UTxO must have ≥2 ADA. Please add funds with 2 separate transactions or wait for UTxO consolidation.',
							);
						}

						const limitedUtxos = sortAndLimitUtxos(
							currentUtxos,
							8_000_000,
							SERVICE_CONSTANTS.SMART_CONTRACT.minSellingWalletUtxoLovelace,
							2,
						);
						const collateralUtxo = limitedUtxos[0];
						const inputUtxos = limitedUtxos.slice(1);
						const firstUtxo = inputUtxos[0];
						if (firstUtxo == null) {
							throw new Error('Expected at least one input UTxO (internal error)');
						}
						const remainingInputUtxos = inputUtxos.slice(1);
						const sortedUtxos = sortUtxosByLovelaceDesc(currentUtxos);

						const assetName = generateAssetName(firstUtxo);
						const metadata = buildAgentMetadata(request);

						logger.info('[register] building evaluation tx', { requestId: request.id });
						const evaluationTx = await generateRegisterAgentTransaction(
							blockchainProvider,
							network,
							script,
							address,
							policyId,
							assetName,
							firstUtxo,
							collateralUtxo,
							remainingInputUtxos,
							metadata,
						);
						logger.info('[register] evaluating tx', { requestId: request.id });
						const estimatedFee = (await blockchainProvider.evaluateTx(evaluationTx)) as Array<{
							budget: { mem: number; steps: number };
						}>;

						logger.info('[register] building final tx', { requestId: request.id });
						const unsignedTx = await generateRegisterAgentTransaction(
							blockchainProvider,
							network,
							script,
							address,
							policyId,
							assetName,
							firstUtxo,
							collateralUtxo,
							remainingInputUtxos,
							metadata,
							estimatedFee[0].budget,
						);

						logger.info('[register] signing tx', { requestId: request.id });
						const signedTx = await wallet.signTx(unsignedTx, true);

						logger.info('[register] updating to RegistrationInitiated', { requestId: request.id });
						await prisma.registryRequest.update({
							where: { id: request.id },
							data: {
								state: RegistrationState.RegistrationInitiated,
								CurrentTransaction: {
									create: {
										txHash: null,
										status: TransactionStatus.Pending,
										BlocksWallet: {
											connect: {
												id: request.SmartContractWallet.id,
											},
										},
									},
								},
							},
						});
						logger.info('[register] submitting tx to chain', { requestId: request.id });
						const newTxHash = await wallet.submitTx(signedTx);

						await walletLowBalanceMonitorService.evaluateProjectedHotWalletById({
							hotWalletId: request.SmartContractWallet.id,
							walletAddress: address,
							walletUtxos: sortedUtxos,
							unsignedTx,
							checkSource: 'submission',
						});
						await prisma.registryRequest.update({
							where: { id: request.id },
							data: {
								agentIdentifier: policyId + assetName,
								CurrentTransaction: {
									update: {
										txHash: newTxHash,
									},
								},
							},
						});

						logger.debug(`Created withdrawal transaction:
                  Tx ID: ${newTxHash}
                  View (after a bit) on https://${
										network === 'preprod' ? 'preprod.' : ''
									}cardanoscan.io/transaction/${newTxHash}
              `);
						return true;
					}),
				});
				let index = 0;
				for (const result of results) {
					const request = registryRequests[index];
					if (result.success === false || result.result !== true) {
						const error = result.error;
						const errStr = errorToString(error);
						logger.error(`[register] FAILED requestId=${request.id} error="${errStr}"`, {
							requestId: request.id,
							error: error,
							errorString: errStr,
						});
						await prisma.registryRequest.update({
							where: { id: request.id },
							data: {
								state: RegistrationState.RegistrationFailed,
								error: errorToString(error),
								SmartContractWallet: {
									update: {
										lockedAt: null,
									},
								},
							},
						});
					}
					index++;
				}
			}),
		);
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
		.txInCollateral(collateralUtxo.input.txHash, collateralUtxo.input.outputIndex)
		.txOut(walletAddress, [
			{
				unit: policyId + assetName,
				quantity: SERVICE_CONSTANTS.SMART_CONTRACT.mintQuantity,
			},
			{
				unit: SERVICE_CONSTANTS.CARDANO.NATIVE_TOKEN,
				quantity: SERVICE_CONSTANTS.SMART_CONTRACT.minNftOutputLovelace,
			},
		]);
	for (const utxo of utxos) {
		txBuilder.txIn(utxo.input.txHash, utxo.input.outputIndex);
	}
	const collateralLovelace = BigInt(
		collateralUtxo.output.amount.find((a) => a.unit === 'lovelace' || a.unit === '')?.quantity ?? '0',
	);
	const minCollateralReturnBigInt = BigInt(SERVICE_CONSTANTS.SMART_CONTRACT.minNftOutputLovelace);
	if (collateralLovelace > minCollateralReturnBigInt) {
		txBuilder.setTotalCollateral((collateralLovelace - minCollateralReturnBigInt).toString());
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
