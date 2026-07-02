import { PaymentSourceType, RegistrationState, TransactionStatus } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { advancedRetryAll, delayErrorResolver } from 'advanced-retry';
import { Mutex } from 'async-mutex';
import { createApiClient, withJobLock } from '@/services/shared';
import { extractAssetName, extractPolicyId } from '@/utils/converter/agent-identifier';
import { unbumpRegistryAssetNameVersionV2 } from '@/services/registry/shared';

const mutex = new Mutex();

// The update service flips a row's `agentIdentifier` to the version-bumped value
// at submit time (before the tx confirms). When tx-sync force-fails a DROPPED
// update, the bumped asset was never minted — only the previous-version asset is
// on chain. Revert the identifier to that pre-bump value so the UpdateFailed row
// stays reachable by the identifier-keyed update/deregister routes (which look
// up by `agentIdentifier`). Returns null — keep the bumped value in place — if
// the identifier is missing or malformed, rather than throwing and re-sticking
// the row in UpdateInitiated.
function revertBumpedAgentIdentifier(agentIdentifier: string | null): string | null {
	if (!agentIdentifier) {
		return null;
	}
	try {
		const policyId = extractPolicyId(agentIdentifier);
		const assetName = extractAssetName(agentIdentifier);
		return policyId + unbumpRegistryAssetNameVersionV2(assetName);
	} catch (error) {
		logger.warn('V2 update tx-sync: could not revert bumped agentIdentifier on dropped update; keeping bumped value', {
			agentIdentifier,
			error: error instanceof Error ? { message: error.message, name: error.name } : error,
		});
		return null;
	}
}

export async function checkRegistryTransactionsV2() {
	await withJobLock(mutex, 'registry_tx_sync_v2', async () => {
		try {
			const paymentContracts = await getPaymentSourcesForSync();
			if (paymentContracts.length == 0) {
				logger.warn(
					'No payment contracts found, skipping update. It could be that an other instance is already syncing',
				);
				return;
			}

			try {
				const results = await Promise.allSettled(
					paymentContracts.map(async (paymentContract) => {
						const blockfrost = createApiClient(
							paymentContract.network,
							paymentContract.PaymentSourceConfig.rpcProviderApiKey,
						);

						const registryRequests = await getRegistrationRequestsToSync(paymentContract.id);
						await syncRegistryRequests(registryRequests, blockfrost);
					}),
				);

				const failedResults = results.filter((x) => x.status == 'rejected');
				if (failedResults.length > 0) {
					logger.error('Error updating registry requests', {
						error: failedResults,
						paymentContract: paymentContracts,
					});
				}
			} catch (error) {
				logger.error('Error checking latest transactions', { error: error });
			}
		} catch (error) {
			logger.error('Error checking latest transactions', { error: error });
		}
	});
}

async function syncRegistryRequests(
	registryRequests: Array<{
		id: string;
		state: RegistrationState;
		CurrentTransaction: {
			BlocksWallet: { id: string } | null;
			txHash: string | null;
			status: TransactionStatus;
		} | null;
		agentIdentifier: string | null;
	}>,
	blockfrost: BlockFrostAPI,
) {
	const results = await advancedRetryAll({
		operations: registryRequests.map((registryRequest) => async () => {
			const owner = await blockfrost.assetsAddresses(registryRequest.agentIdentifier!, {
				order: 'desc',
			});

			if (registryRequest.state == RegistrationState.RegistrationInitiated) {
				if (owner.length >= 1 && owner[0].quantity == '1') {
					if (registryRequest.CurrentTransaction == undefined || registryRequest.CurrentTransaction.txHash == null) {
						throw new Error('Registry request has no tx hash');
					}
					const tx = await blockfrost.txs(registryRequest.CurrentTransaction.txHash);
					const block = await blockfrost.blocks(tx.block);
					const confirmations = block.confirmations;
					await prisma.registryRequest.update({
						where: { id: registryRequest.id },
						data: {
							state: RegistrationState.RegistrationConfirmed,
							CurrentTransaction: {
								update: {
									status: TransactionStatus.Confirmed,
									confirmations: confirmations,
									fees: BigInt(tx.fees),
									blockHeight: tx.block_height,
									blockTime: tx.block_time,
									outputAmount: JSON.stringify(tx.output_amount),
									utxoCount: tx.utxo_count,
									withdrawalCount: tx.withdrawal_count,
									assetMintOrBurnCount: tx.asset_mint_or_burn_count,
									redeemerCount: tx.redeemer_count,
									validContract: tx.valid_contract,
									BlocksWallet:
										registryRequest.CurrentTransaction?.BlocksWallet != null ? { disconnect: true } : undefined,
								},
							},
						},
					});
					if (registryRequest.CurrentTransaction?.BlocksWallet != null) {
						await prisma.hotWallet.update({
							where: {
								id: registryRequest.CurrentTransaction.BlocksWallet.id,
								deletedAt: null,
							},
							data: {
								lockedAt: null,
							},
						});
					}
				} else if (registryRequest.CurrentTransaction?.status === TransactionStatus.FailedViaTimeout) {
					// Force-failed by the wallet-lock timeout sweep (broadcast but never
					// seen on chain past the lock timeout) AND the asset is still absent —
					// the tx was dropped, not merely indexer-lagged (a landed tx matches
					// the confirm branch above). Surface as RegistrationFailed so the row
					// is not left invisible-stuck in RegistrationInitiated forever.
					await prisma.registryRequest.update({
						where: { id: registryRequest.id },
						data: {
							state: RegistrationState.RegistrationFailed,
							error:
								'Registration transaction was broadcast but never landed on chain (dropped); force-failed by the wallet-lock timeout sweep',
						},
					});
				} else {
					await prisma.registryRequest.update({
						where: { id: registryRequest.id },
						data: {
							updatedAt: new Date(),
						},
					});
				}
			} else if (registryRequest.state == RegistrationState.DeregistrationInitiated) {
				if (owner.length == 0 || owner[0].quantity == '0') {
					if (registryRequest.CurrentTransaction == undefined || registryRequest.CurrentTransaction.txHash == null) {
						throw new Error('Deregistration request has no tx hash');
					}
					const tx = await blockfrost.txs(registryRequest.CurrentTransaction.txHash);
					const block = await blockfrost.blocks(tx.block);
					const confirmations = block.confirmations;
					await prisma.registryRequest.update({
						where: { id: registryRequest.id },
						data: {
							state: RegistrationState.DeregistrationConfirmed,
							CurrentTransaction: {
								update: {
									status: TransactionStatus.Confirmed,
									confirmations: confirmations,
									fees: BigInt(tx.fees),
									blockHeight: tx.block_height,
									blockTime: tx.block_time,
									outputAmount: JSON.stringify(tx.output_amount),
									utxoCount: tx.utxo_count,
									withdrawalCount: tx.withdrawal_count,
									assetMintOrBurnCount: tx.asset_mint_or_burn_count,
									redeemerCount: tx.redeemer_count,
									validContract: tx.valid_contract,
									BlocksWallet:
										registryRequest.CurrentTransaction?.BlocksWallet != null ? { disconnect: true } : undefined,
								},
							},
						},
					});
					if (registryRequest.CurrentTransaction?.BlocksWallet != null) {
						await prisma.hotWallet.update({
							where: {
								id: registryRequest.CurrentTransaction.BlocksWallet.id,
								deletedAt: null,
							},
							data: {
								lockedAt: null,
							},
						});
					}
				} else if (registryRequest.CurrentTransaction?.status === TransactionStatus.FailedViaTimeout) {
					// Force-failed by the wallet-lock timeout sweep and the asset is still
					// on chain (deregistration never took effect) — the burn tx was
					// dropped. Surface as DeregistrationFailed so the row is not left
					// invisible-stuck in DeregistrationInitiated forever.
					await prisma.registryRequest.update({
						where: { id: registryRequest.id },
						data: {
							state: RegistrationState.DeregistrationFailed,
							error:
								'Deregistration transaction was broadcast but never landed on chain (dropped); force-failed by the wallet-lock timeout sweep',
						},
					});
				} else {
					await prisma.registryRequest.update({
						where: { id: registryRequest.id },
						data: {
							updatedAt: new Date(),
						},
					});
				}
			} else if (registryRequest.state == RegistrationState.UpdateInitiated) {
				// UpdateAction atomically burns the prior asset and mints the
				// next-version asset. The DB row's `agentIdentifier` was
				// flipped to the new (bumped-version) value at submit time,
				// so the same blockfrost asset lookup as the registration
				// check applies: "does the NEW asset exist on chain?". If
				// yes, the update tx landed.
				if (owner.length >= 1 && owner[0].quantity == '1') {
					if (registryRequest.CurrentTransaction == undefined || registryRequest.CurrentTransaction.txHash == null) {
						throw new Error('Update request has no tx hash');
					}
					const tx = await blockfrost.txs(registryRequest.CurrentTransaction.txHash);
					const block = await blockfrost.blocks(tx.block);
					const confirmations = block.confirmations;
					await prisma.registryRequest.update({
						where: { id: registryRequest.id },
						data: {
							state: RegistrationState.UpdateConfirmed,
							CurrentTransaction: {
								update: {
									status: TransactionStatus.Confirmed,
									confirmations: confirmations,
									fees: BigInt(tx.fees),
									blockHeight: tx.block_height,
									blockTime: tx.block_time,
									outputAmount: JSON.stringify(tx.output_amount),
									utxoCount: tx.utxo_count,
									withdrawalCount: tx.withdrawal_count,
									assetMintOrBurnCount: tx.asset_mint_or_burn_count,
									redeemerCount: tx.redeemer_count,
									validContract: tx.valid_contract,
									BlocksWallet:
										registryRequest.CurrentTransaction?.BlocksWallet != null ? { disconnect: true } : undefined,
								},
							},
						},
					});
					if (registryRequest.CurrentTransaction?.BlocksWallet != null) {
						await prisma.hotWallet.update({
							where: {
								id: registryRequest.CurrentTransaction.BlocksWallet.id,
								deletedAt: null,
							},
							data: {
								lockedAt: null,
							},
						});
					}
				} else if (registryRequest.CurrentTransaction?.status === TransactionStatus.FailedViaTimeout) {
					// Force-failed by the wallet-lock timeout sweep and the new
					// (version-bumped) asset is still absent — the burn+remint tx was
					// dropped, so nothing changed on chain: only the PREVIOUS-version asset
					// is on chain. The row's agentIdentifier was optimistically flipped to
					// the bumped value at submit time; revert it to the pre-bump identifier
					// so the UpdateFailed row stays reachable by the identifier-keyed
					// update/deregister routes (UpdateFailed is a retriable state). Surface
					// as UpdateFailed so it is not left invisible-stuck in UpdateInitiated.
					const revertedAgentIdentifier = revertBumpedAgentIdentifier(registryRequest.agentIdentifier);
					await prisma.registryRequest.update({
						where: { id: registryRequest.id },
						data: {
							state: RegistrationState.UpdateFailed,
							...(revertedAgentIdentifier != null ? { agentIdentifier: revertedAgentIdentifier } : {}),
							error:
								'Update transaction was broadcast but never landed on chain (dropped); force-failed by the wallet-lock timeout sweep',
						},
					});
				} else {
					await prisma.registryRequest.update({
						where: { id: registryRequest.id },
						data: {
							updatedAt: new Date(),
						},
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
	results.forEach((x) => {
		if (x.success == false) {
			logger.warn('Failed to update registry request', {
				error: x.error,
			});
		}
	});
}

async function getRegistrationRequestsToSync(paymentContractId: string) {
	return await prisma.registryRequest.findMany({
		where: {
			PaymentSource: {
				id: paymentContractId,
			},
			state: {
				in: [
					RegistrationState.RegistrationInitiated,
					RegistrationState.DeregistrationInitiated,
					RegistrationState.UpdateInitiated,
				],
			},
			CurrentTransaction: {
				isNot: null,
			},
			agentIdentifier: { not: null },
			updatedAt: {
				lt: new Date(
					Date.now() -
						//15 minutes for timeouts, check every tx older than 1 minute
						1000 * 60 * 1,
				),
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
			paymentSourceType: PaymentSourceType.Web3CardanoV2,
		},
		include: {
			PaymentSourceConfig: true,
		},
	});
}
