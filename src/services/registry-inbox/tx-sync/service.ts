import { RegistrationState, TransactionStatus } from '@/generated/prisma/client';
import { prisma } from '@/utils/db';
import { logger } from '@/utils/logger';
import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { advancedRetryAll, delayErrorResolver } from 'advanced-retry';
import { Mutex } from 'async-mutex';
import { createApiClient, withJobLock } from '@/services/shared';

const mutex = new Mutex();

export async function checkInboxAgentRegistrationTransactions() {
	await withJobLock(mutex, 'registry_inbox_tx_sync', async () => {
		try {
			const paymentContracts = await getPaymentSourcesForSync();
			if (paymentContracts.length === 0) {
				logger.warn('No payment contracts found for inbox tx sync, skipping update');
				return;
			}

			try {
				const results = await Promise.allSettled(
					paymentContracts.map(async (paymentContract) => {
						const blockfrost = createApiClient(
							paymentContract.network,
							paymentContract.PaymentSourceConfig.rpcProviderApiKey,
						);

						const registrationRequests = await getInboxAgentRegistrationRequestsToSync(paymentContract.id);
						await syncInboxAgentRegistrationRequests(registrationRequests, blockfrost);
					}),
				);

				const failedResults = results.filter((x) => x.status === 'rejected');
				if (failedResults.length > 0) {
					logger.error('Error updating inbox agent registration requests', {
						error: failedResults,
						paymentContracts,
					});
				}
			} catch (error) {
				logger.error('Error checking latest inbox agent registration transactions', { error });
			}
		} catch (error) {
			logger.error('Error checking latest inbox agent registration transactions', { error });
		}
	});
}

async function syncInboxAgentRegistrationRequests(
	registrationRequests: Array<{
		id: string;
		state: RegistrationState;
		CurrentTransaction: {
			BlocksWallet: { id: string } | null;
			txHash: string | null;
		} | null;
		agentIdentifier: string | null;
	}>,
	blockfrost: BlockFrostAPI,
) {
	const results = await advancedRetryAll({
		operations: registrationRequests.map((request) => async () => {
			const owner = await blockfrost.assetsAddresses(request.agentIdentifier!, {
				order: 'desc',
			});

			if (request.state === RegistrationState.RegistrationInitiated) {
				if (owner.length >= 1 && owner[0].quantity === '1') {
					if (request.CurrentTransaction == null || request.CurrentTransaction.txHash == null) {
						throw new Error('Inbox agent registration request has no tx hash');
					}
					const tx = await blockfrost.txs(request.CurrentTransaction.txHash);
					const block = await blockfrost.blocks(tx.block);
					await prisma.inboxAgentRegistrationRequest.update({
						where: { id: request.id },
						data: {
							state: RegistrationState.RegistrationConfirmed,
							CurrentTransaction: {
								update: {
									status: TransactionStatus.Confirmed,
									confirmations: block.confirmations,
									fees: BigInt(tx.fees),
									blockHeight: tx.block_height,
									blockTime: tx.block_time,
									outputAmount: JSON.stringify(tx.output_amount),
									utxoCount: tx.utxo_count,
									withdrawalCount: tx.withdrawal_count,
									assetMintOrBurnCount: tx.asset_mint_or_burn_count,
									redeemerCount: tx.redeemer_count,
									validContract: tx.valid_contract,
									BlocksWallet: request.CurrentTransaction.BlocksWallet != null ? { disconnect: true } : undefined,
								},
							},
						},
					});
					if (request.CurrentTransaction.BlocksWallet != null) {
						await prisma.hotWallet.update({
							where: {
								id: request.CurrentTransaction.BlocksWallet.id,
								deletedAt: null,
							},
							data: {
								lockedAt: null,
							},
						});
					}
				} else {
					await prisma.inboxAgentRegistrationRequest.update({
						where: { id: request.id },
						data: { updatedAt: new Date() },
					});
				}
			} else if (request.state === RegistrationState.DeregistrationInitiated) {
				if (owner.length === 0 || owner[0].quantity === '0') {
					if (request.CurrentTransaction == null || request.CurrentTransaction.txHash == null) {
						throw new Error('Inbox deregistration request has no tx hash');
					}
					const tx = await blockfrost.txs(request.CurrentTransaction.txHash);
					const block = await blockfrost.blocks(tx.block);
					await prisma.inboxAgentRegistrationRequest.update({
						where: { id: request.id },
						data: {
							state: RegistrationState.DeregistrationConfirmed,
							CurrentTransaction: {
								update: {
									status: TransactionStatus.Confirmed,
									confirmations: block.confirmations,
									fees: BigInt(tx.fees),
									blockHeight: tx.block_height,
									blockTime: tx.block_time,
									outputAmount: JSON.stringify(tx.output_amount),
									utxoCount: tx.utxo_count,
									withdrawalCount: tx.withdrawal_count,
									assetMintOrBurnCount: tx.asset_mint_or_burn_count,
									redeemerCount: tx.redeemer_count,
									validContract: tx.valid_contract,
									BlocksWallet: request.CurrentTransaction.BlocksWallet != null ? { disconnect: true } : undefined,
								},
							},
						},
					});
					if (request.CurrentTransaction.BlocksWallet != null) {
						await prisma.hotWallet.update({
							where: {
								id: request.CurrentTransaction.BlocksWallet.id,
								deletedAt: null,
							},
							data: {
								lockedAt: null,
							},
						});
					}
				} else {
					await prisma.inboxAgentRegistrationRequest.update({
						where: { id: request.id },
						data: { updatedAt: new Date() },
					});
				}
			}
		}),
		errorResolvers: [
			delayErrorResolver({
				configuration: {
					maxRetries: 5,
					backoffMultiplier: 2,
					initialDelayMs: 500,
					maxDelayMs: 1500,
				},
			}),
		],
	});

	results.forEach((result) => {
		if (result.success === false) {
			logger.warn('Failed to update inbox agent registration request', {
				error: result.error,
			});
		}
	});
}

async function getInboxAgentRegistrationRequestsToSync(paymentContractId: string) {
	return await prisma.inboxAgentRegistrationRequest.findMany({
		where: {
			PaymentSource: {
				id: paymentContractId,
			},
			state: {
				in: [RegistrationState.RegistrationInitiated, RegistrationState.DeregistrationInitiated],
			},
			CurrentTransaction: {
				isNot: null,
			},
			agentIdentifier: { not: null },
			updatedAt: {
				lt: new Date(Date.now() - 1000 * 60 * 1),
			},
		},
		include: {
			CurrentTransaction: { include: { BlocksWallet: true } },
		},
	});
}

async function getPaymentSourcesForSync() {
	return await prisma.paymentSource.findMany({
		where: {
			deletedAt: null,
			disableSyncAt: null,
		},
		include: {
			PaymentSourceConfig: true,
		},
	});
}
