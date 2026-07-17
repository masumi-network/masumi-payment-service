import { adminAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { logger } from '@masumi/payment-core/logger';
import { prisma } from '@masumi/payment-core/db';
import createHttpError from 'http-errors';
import { CONSTANTS } from '@masumi/payment-core/config';
import { HotWalletType, FundDistributionStatus } from '@/generated/prisma/client';
import { encrypt } from '@/utils/security/encryption';
import { resolvePaymentKeyHash } from '@meshsdk/core';
import { generateOfflineWallet } from '@/utils/generator/wallet-generator';
import { fetchAddressBalanceMap } from '@/services/shared/address-balance';
import { walletLowBalanceMonitorService, serializeLowBalanceSummary } from '@/services/wallets';
import { isUniqueConstraintError, retryOnSerializationConflict } from '@masumi/payment-core/db-retry';
import {
	deleteFundWalletSchemaInput,
	deleteFundWalletSchemaOutput,
	getFundWalletSchemaInput,
	getFundWalletSchemaOutput,
	patchFundWalletSchemaInput,
	patchFundWalletSchemaOutput,
	postFundWalletSchemaInput,
	postFundWalletSchemaOutput,
} from './schemas';

export {
	getFundWalletSchemaInput,
	getFundWalletSchemaOutput,
	postFundWalletSchemaInput,
	postFundWalletSchemaOutput,
	patchFundWalletSchemaInput,
	patchFundWalletSchemaOutput,
	deleteFundWalletSchemaInput,
	deleteFundWalletSchemaOutput,
};

type AssetConfigInput = {
	assetUnit: string;
	warningThreshold: string;
	criticalThreshold: string;
	topupAmount: string;
};

/**
 * Validate one asset's policy.
 *
 * The min-UTxO floor applies to LOVELACE ONLY. It exists because an ADA output
 * below min-UTxO can never build — but a token quantity has no such bound, and
 * applying an ADA floor to it would reject a perfectly sensible 1 USDM top-up.
 * The ADA a token output needs is added at build time, not configured here.
 */
function parseAssetConfig(asset: AssetConfigInput) {
	const warningThreshold = BigInt(asset.warningThreshold);
	const criticalThreshold = BigInt(asset.criticalThreshold);
	const topupAmount = BigInt(asset.topupAmount);

	if (criticalThreshold >= warningThreshold) {
		throw createHttpError(400, `criticalThreshold must be less than warningThreshold for ${asset.assetUnit}`);
	}
	if (topupAmount <= 0n) {
		throw createHttpError(400, `topupAmount must be greater than zero for ${asset.assetUnit}`);
	}
	if (asset.assetUnit === 'lovelace' && topupAmount < CONSTANTS.MIN_TOPUP_LOVELACE) {
		throw createHttpError(
			400,
			`topupAmount must be at least ${CONSTANTS.MIN_TOPUP_LOVELACE.toString()} lovelace; ` +
				'a smaller output cannot satisfy the Cardano min-UTxO requirement',
		);
	}

	return { assetUnit: asset.assetUnit, warningThreshold, criticalThreshold, topupAmount };
}

/** Validate the whole policy, rejecting a duplicated asset rather than silently keeping one. */
function parseAssetConfigs(assets: AssetConfigInput[]) {
	const seen = new Set<string>();
	for (const asset of assets) {
		if (seen.has(asset.assetUnit)) {
			throw createHttpError(400, `Duplicate assetUnit in Assets: ${asset.assetUnit}`);
		}
		seen.add(asset.assetUnit);
	}
	return assets.map(parseAssetConfig);
}

function serializeConfig(config: {
	id: string;
	enabled: boolean;
	batchWindowMs: number;
	AssetConfigs: Array<{
		assetUnit: string;
		warningThreshold: bigint;
		criticalThreshold: bigint;
		topupAmount: bigint;
	}>;
}) {
	return {
		id: config.id,
		enabled: config.enabled,
		batchWindowMs: config.batchWindowMs,
		Assets: config.AssetConfigs.map((asset) => ({
			assetUnit: asset.assetUnit,
			warningThreshold: asset.warningThreshold.toString(),
			criticalThreshold: asset.criticalThreshold.toString(),
			topupAmount: asset.topupAmount.toString(),
		})),
	};
}

export const getFundWalletEndpointGet = adminAuthenticatedEndpointFactory.build({
	method: 'get',
	input: getFundWalletSchemaInput,
	output: getFundWalletSchemaOutput,
	handler: async ({ input }) => {
		if (!input.id && !input.paymentSourceId) {
			throw createHttpError(400, 'Either id or paymentSourceId must be provided');
		}

		const wallet = await prisma.hotWallet.findFirst({
			where: {
				...(input.id ? { id: input.id } : {}),
				...(input.paymentSourceId ? { paymentSourceId: input.paymentSourceId } : {}),
				type: HotWalletType.Funding,
				deletedAt: null,
			},
			select: {
				id: true,
				walletAddress: true,
				walletVkey: true,
				note: true,
				paymentSourceId: true,
				lockedAt: true,
				LowBalanceRules: {
					where: { enabled: true },
					select: {
						id: true,
						assetUnit: true,
						thresholdAmount: true,
						enabled: true,
						status: true,
						lastKnownAmount: true,
						lastCheckedAt: true,
						lastAlertedAt: true,
					},
				},
				FundDistributionConfig: {
					select: {
						id: true,
						enabled: true,
						batchWindowMs: true,
						AssetConfigs: {
							select: {
								assetUnit: true,
								warningThreshold: true,
								criticalThreshold: true,
								topupAmount: true,
							},
							orderBy: { assetUnit: 'asc' },
						},
					},
				},
				_count: {
					select: {
						FundDistributionsSent: {
							where: { status: FundDistributionStatus.Pending },
						},
					},
				},
			},
		});

		if (!wallet) {
			throw createHttpError(404, 'Fund wallet not found');
		}

		return {
			id: wallet.id,
			walletAddress: wallet.walletAddress,
			walletVkey: wallet.walletVkey,
			note: wallet.note ?? null,
			paymentSourceId: wallet.paymentSourceId,
			lockedAt: wallet.lockedAt ?? null,
			LowBalanceSummary: serializeLowBalanceSummary(wallet.LowBalanceRules),
			FundDistributionConfig: wallet.FundDistributionConfig ? serializeConfig(wallet.FundDistributionConfig) : null,
			pendingRequestCount: wallet._count.FundDistributionsSent,
		};
	},
});

export const postFundWalletEndpointPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: postFundWalletSchemaInput,
	output: postFundWalletSchemaOutput,
	handler: async ({ input }) => {
		const paymentSource = await prisma.paymentSource.findUnique({
			where: { id: input.paymentSourceId, deletedAt: null },
			select: { id: true, network: true },
		});

		if (!paymentSource) {
			throw createHttpError(404, 'Payment source not found');
		}

		const existingFundWallet = await prisma.hotWallet.findFirst({
			where: {
				paymentSourceId: input.paymentSourceId,
				type: HotWalletType.Funding,
				deletedAt: null,
			},
			select: { id: true },
		});

		if (existingFundWallet) {
			throw createHttpError(409, 'A fund wallet already exists for this payment source');
		}

		const assetConfigs = parseAssetConfigs(input.Assets);

		// A typo'd or truncated phrase is ordinary user input, not an exception:
		// MeshWallet throws a bare bip39 Error, which would otherwise surface as a
		// 500 plus an error-level log and a business-error metric.
		const normalizedMnemonic = input.walletMnemonic.trim().split(/\s+/).join(' ');
		let address: string | undefined;
		try {
			const mnemonicWords = normalizedMnemonic.split(' ');
			const offlineWallet = generateOfflineWallet(paymentSource.network, mnemonicWords);
			const unusedAddresses = await offlineWallet.getUnusedAddresses();
			address = unusedAddresses[0];
		} catch {
			// Deliberately does not echo the cause: it can quote the phrase back.
			throw createHttpError(400, 'Invalid mnemonic phrase');
		}
		if (!address) {
			throw createHttpError(400, 'Could not derive address from provided mnemonic');
		}
		const vKey = resolvePaymentKeyHash(address);
		const encryptedMnemonic = encrypt(normalizedMnemonic);

		let result;
		try {
			result = await retryOnSerializationConflict(
				() =>
					prisma.$transaction(
						async (tx) => {
							// The source was loaded before mnemonic derivation. It may
							// have been deleted while that async work ran, so claim its
							// active lifecycle in the same serializable transaction as
							// the treasury insert.
							const activePaymentSource = await tx.paymentSource.findUnique({
								where: { id: input.paymentSourceId, deletedAt: null },
								select: { id: true },
							});
							if (activePaymentSource == null) {
								throw createHttpError(409, 'Payment source is no longer active');
							}

							const secret = await tx.walletSecret.create({
								data: { encryptedMnemonic },
							});

							const hotWallet = await tx.hotWallet.create({
								data: {
									walletAddress: address,
									walletVkey: vKey,
									type: HotWalletType.Funding,
									secretId: secret.id,
									paymentSourceId: input.paymentSourceId,
									note: input.note ?? null,
								},
							});

							const config = await tx.fundDistributionConfig.create({
								data: {
									hotWalletId: hotWallet.id,
									enabled: true,
									batchWindowMs: input.batchWindowMs ?? CONSTANTS.FUND_DISTRIBUTION_DEFAULT_BATCH_WINDOW_MS,
									AssetConfigs: { create: assetConfigs },
								},
								select: {
									id: true,
									enabled: true,
									batchWindowMs: true,
									AssetConfigs: {
										select: {
											assetUnit: true,
											warningThreshold: true,
											criticalThreshold: true,
											topupAmount: true,
										},
										orderBy: { assetUnit: 'asc' },
									},
								},
							});

							return { hotWallet, config };
						},
						{ isolationLevel: 'Serializable' },
					),
				{ label: 'fund-wallet-create' },
			);
		} catch (error) {
			// HotWallet.walletVkey is globally unique, not per payment source, so the
			// same mnemonic cannot back two wallets anywhere in the system. The
			// natural operator move -- reuse one treasury mnemonic for the V1 and the
			// V2 source -- lands here. Without this it surfaced as a raw Prisma error
			// and a 500, which reads as a bug rather than a constraint.
			if (isUniqueConstraintError(error)) {
				// The database constraint is the authoritative race-safe check. If
				// another request won creation for this source, report that conflict;
				// otherwise the globally unique walletVkey/mnemonic was reused.
				const activeFundWallet = await prisma.hotWallet.findFirst({
					where: {
						paymentSourceId: input.paymentSourceId,
						type: HotWalletType.Funding,
						deletedAt: null,
					},
					select: { id: true },
				});
				if (activeFundWallet) {
					throw createHttpError(409, 'A fund wallet already exists for this payment source');
				}
				throw createHttpError(
					409,
					'This wallet is already registered. A wallet mnemonic can only back one wallet, so each payment source needs its own fund wallet with its own mnemonic.',
				);
			}
			throw error;
		}

		// Seed default low-balance rules. Runs outside the creation transaction because
		// seedDefaultRulesForWallets uses the global prisma client, not a tx client.
		// If seeding fails the wallet is still created; rules can be added via the low-balance rule API.
		try {
			await walletLowBalanceMonitorService.seedDefaultRulesForWallets([result.hotWallet.id]);
		} catch (seedError) {
			logger.warn('Failed to seed default low-balance rules for new fund wallet', {
				component: 'fund_wallet',
				fund_wallet_id: result.hotWallet.id,
				error: seedError instanceof Error ? seedError.message : String(seedError),
			});
		}

		return {
			id: result.hotWallet.id,
			walletAddress: result.hotWallet.walletAddress,
			walletVkey: result.hotWallet.walletVkey,
			paymentSourceId: result.hotWallet.paymentSourceId,
			FundDistributionConfig: serializeConfig(result.config),
		};
	},
});

export const patchFundWalletEndpointPatch = adminAuthenticatedEndpointFactory.build({
	method: 'patch',
	input: patchFundWalletSchemaInput,
	output: patchFundWalletSchemaOutput,
	handler: async ({ input }) => {
		const wallet = await prisma.hotWallet.findUnique({
			where: { id: input.id, type: HotWalletType.Funding, deletedAt: null },
			select: { id: true, FundDistributionConfig: { select: { id: true } } },
		});

		if (!wallet) {
			throw createHttpError(404, 'Fund wallet not found');
		}

		const configId = wallet.FundDistributionConfig?.id;
		if (configId == null) {
			throw createHttpError(404, 'Fund wallet has no distribution config');
		}

		// Validate before opening the transaction: the min-UTxO floor is enforced
		// on update too, or it is trivially bypassed by creating a valid wallet and
		// editing the amount down afterwards.
		const assetConfigs = input.Assets != null ? parseAssetConfigs(input.Assets) : null;

		const updated = await retryOnSerializationConflict(
			() =>
				prisma.$transaction(
					async (tx) => {
						// Replace the policy wholesale rather than patching rows: each asset
						// row is then written as a validated (warning, critical, topup)
						// triple. Patching columns individually let two concurrent updates
						// (warning down, critical up) each validate against stale data and
						// interleave into critical >= warning — after which every low balance
						// classified Critical and bypassed the batch window.
						if (assetConfigs != null) {
							await tx.fundDistributionAssetConfig.deleteMany({ where: { fundDistributionConfigId: configId } });
							await tx.fundDistributionAssetConfig.createMany({
								data: assetConfigs.map((asset) => ({ ...asset, fundDistributionConfigId: configId })),
							});
						}

						return tx.fundDistributionConfig.update({
							where: { id: configId },
							data: {
								...(input.enabled != null ? { enabled: input.enabled } : {}),
								...(input.batchWindowMs != null ? { batchWindowMs: input.batchWindowMs } : {}),
							},
							select: {
								id: true,
								enabled: true,
								batchWindowMs: true,
								AssetConfigs: {
									select: {
										assetUnit: true,
										warningThreshold: true,
										criticalThreshold: true,
										topupAmount: true,
									},
									orderBy: { assetUnit: 'asc' },
								},
							},
						});
					},
					{ isolationLevel: 'Serializable' },
				),
			{ label: 'fund-wallet-patch' },
		);

		return {
			id: wallet.id,
			FundDistributionConfig: serializeConfig(updated),
		};
	},
});

export const deleteFundWalletEndpointDelete = adminAuthenticatedEndpointFactory.build({
	method: 'delete',
	input: deleteFundWalletSchemaInput,
	output: deleteFundWalletSchemaOutput,
	handler: async ({ input }) => {
		const wallet = await prisma.hotWallet.findUnique({
			where: { id: input.id, type: HotWalletType.Funding, deletedAt: null },
			select: {
				id: true,
				walletAddress: true,
				lockedAt: true,
				pendingTransactionId: true,
				FundDistributionsSent: {
					where: {
						OR: [
							{ status: FundDistributionStatus.Submitted },
							{ status: FundDistributionStatus.Pending, transactionId: { not: null } },
						],
					},
					select: { id: true },
					take: 1,
				},
				PaymentSource: {
					select: { network: true, PaymentSourceConfig: { select: { rpcProviderApiKey: true } } },
				},
			},
		});

		if (!wallet) {
			throw createHttpError(404, 'Fund wallet not found');
		}

		// A broadcast or ambiguous batch cannot be cancelled by deleting its DB
		// row. This guard is never bypassed by `force`; force only skips the balance
		// check below.
		if (wallet.lockedAt != null || wallet.pendingTransactionId != null || wallet.FundDistributionsSent.length > 0) {
			throw createHttpError(409, 'Fund wallet has a distribution in flight. Wait for it to settle before deleting.');
		}

		if (!input.force) {
			// Refuse to strand funds. Every read path filters `deletedAt: null`, so
			// once soft-deleted the mnemonic is unreachable through the API and the
			// balance is recoverable only with DB access plus the ENCRYPTION_KEY.
			const rpcProviderApiKey = wallet.PaymentSource.PaymentSourceConfig?.rpcProviderApiKey;
			// A missing/blank key means we CANNOT check — which is a reason to stop,
			// not to proceed. Skipping the check here would silently delete a funded
			// wallet, the exact outcome this guard exists to prevent.
			if (!rpcProviderApiKey) {
				throw createHttpError(
					503,
					'No RPC provider key configured for this payment source, so the fund wallet balance cannot be checked. Pass force=true to delete without the check.',
				);
			}

			let lovelace: bigint;
			try {
				const balanceMap = await fetchAddressBalanceMap({
					network: wallet.PaymentSource.network,
					rpcProviderApiKey,
					address: wallet.walletAddress,
				});
				lovelace = balanceMap.get('lovelace') ?? 0n;
			} catch {
				// Balance unknown (indexer down). Deleting blind could strand funds,
				// so make the operator choose rather than guessing for them.
				throw createHttpError(
					503,
					'Could not check the fund wallet balance before deleting. Retry, or pass force=true to delete without the check.',
				);
			}

			if (lovelace > 0n) {
				throw createHttpError(
					409,
					`Fund wallet still holds ${lovelace.toString()} lovelace. Withdraw it first — after deletion the ` +
						'mnemonic can no longer be exported through the API. Pass force=true to delete anyway.',
				);
			}
		}

		const didDelete = await retryOnSerializationConflict(
			() =>
				prisma.$transaction(
					async (tx) => {
						// Re-check and claim deletion atomically with the same fields the
						// batch executor uses for its wallet claim. Whichever transaction
						// wins makes the other's conditional update affect zero rows.
						const deleted = await tx.hotWallet.updateMany({
							where: {
								id: input.id,
								type: HotWalletType.Funding,
								deletedAt: null,
								lockedAt: null,
								pendingTransactionId: null,
								FundDistributionsSent: {
									none: {
										OR: [
											{ status: FundDistributionStatus.Submitted },
											{ status: FundDistributionStatus.Pending, transactionId: { not: null } },
										],
									},
								},
							},
							data: { deletedAt: new Date() },
						});
						if (deleted.count !== 1) return false;

						await tx.fundDistributionConfig.updateMany({
							where: { hotWalletId: input.id },
							data: { enabled: false },
						});

						// Only unclaimed Pending requests are cancellable. Submitted requests
						// are protected by the guarded delete because broadcast cannot be undone.
						await tx.fundDistributionRequest.updateMany({
							where: {
								fundWalletId: input.id,
								status: FundDistributionStatus.Pending,
								transactionId: null,
							},
							data: {
								status: FundDistributionStatus.Failed,
								error: 'Fund wallet was deleted',
							},
						});

						return true;
					},
					{ isolationLevel: 'Serializable' },
				),
			{ label: 'fund-wallet-delete' },
		);

		if (!didDelete) {
			throw createHttpError(409, 'Fund wallet has a distribution in flight. Wait for it to settle before deleting.');
		}

		return { id: input.id };
	},
});
