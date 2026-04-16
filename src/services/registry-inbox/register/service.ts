import { RegistrationState } from '@/generated/prisma/client';
import { prisma } from '@/utils/db';
import { logger } from '@/utils/logger';
import { convertNetwork } from '@/utils/converter/network-convert';
import { lockAndQueryInboxAgentRegistrationRequests } from '@/utils/db/lock-and-query-inbox-agent-registration-request';
import { DEFAULTS, SERVICE_CONSTANTS } from '@/utils/config';
import { getRegistryScriptFromNetworkHandlerV1 } from '@/utils/generator/contract-generator';
import { stringToMetadata, cleanMetadata } from '@/utils/converter/metadata-string-convert';
import { advancedRetryAll, delayErrorResolver } from 'advanced-retry';
import { Mutex, MutexInterface, tryAcquire } from 'async-mutex';
import { interpretBlockchainError } from '@/utils/errors/blockchain-error-interpreter';
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
import { INBOX_AGENT_REGISTRATION_METADATA_TYPE } from '@/services/registry-inbox/metadata';

const mutex = new Mutex();

function buildInboxAgentMetadata(request: {
	name: string;
	description: string | null;
	agentSlug: string;
	metadataVersion: number;
}): RegistryMetadata {
	const metadata = {
		type: INBOX_AGENT_REGISTRATION_METADATA_TYPE,
		name: stringToMetadata(request.name),
		description: stringToMetadata(request.description),
		agentslug: stringToMetadata(request.agentSlug),
		metadata_version: request.metadataVersion.toString(),
	};

	return cleanMetadata(metadata) as RegistryMetadata;
}

export async function registerInboxAgentV1() {
	let release: MutexInterface.Releaser | null;
	try {
		release = await tryAcquire(mutex).acquire();
	} catch (e) {
		logger.info('Mutex timeout when locking inbox registrations', { error: e });
		return;
	}

	try {
		const paymentSourcesWithWalletLocked = await lockAndQueryInboxAgentRegistrationRequests({
			state: RegistrationState.RegistrationRequested,
			maxBatchSize: 1,
		});

		await Promise.allSettled(
			paymentSourcesWithWalletLocked.map(async (paymentSource) => {
				if (paymentSource.InboxAgentRegistrationRequests.length === 0) return;

				logger.info(
					`Registering ${paymentSource.InboxAgentRegistrationRequests.length} inbox agents for payment source ${paymentSource.id}`,
				);

				const network = convertNetwork(paymentSource.network);
				const registrationRequests = paymentSource.InboxAgentRegistrationRequests;

				if (registrationRequests.length === 0) return;

				const blockchainProvider = createMeshProvider(paymentSource.PaymentSourceConfig.rpcProviderApiKey);

				const results = await advancedRetryAll({
					errorResolvers: [
						delayErrorResolver({
							configuration: SERVICE_CONSTANTS.RETRY,
						}),
					],
					operations: registrationRequests.map((request) => async () => {
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
						const metadata = buildInboxAgentMetadata({
							name: request.name,
							description: request.description,
							agentSlug: request.agentSlug,
							metadataVersion: request.metadataVersion ?? DEFAULTS.DEFAULT_METADATA_VERSION,
						});

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
								agentIdentifier: policyId + assetName,
								...updateCurrentTransactionHash(newTxHash),
							},
						});

						logger.debug(`Created inbox agent registration transaction:
                  Tx ID: ${newTxHash}
                  View (after a bit) on https://${network === 'preprod' ? 'preprod.' : ''}cardanoscan.io/transaction/${newTxHash}
              `);
						return true;
					}),
				});

				let index = 0;
				for (const result of results) {
					const request = registrationRequests[index];
					if (result.success === false || result.result !== true) {
						const error = result.error;
						logger.error(`Error registering inbox agent ${request.id}`, {
							error,
						});
						await prisma.inboxAgentRegistrationRequest.update({
							where: { id: request.id },
							data: {
								state: RegistrationState.RegistrationFailed,
								error: interpretBlockchainError(error),
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
		logger.error('Error registering inbox agent', { error });
	} finally {
		release();
	}
}
