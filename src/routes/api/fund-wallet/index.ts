import { adminAuthenticatedEndpointFactory, checkIsAllowedNetworkOrThrowUnauthorized } from '@masumi/payment-core/auth';
import { buildHotWalletScopeFilter } from '@/utils/shared/wallet-scope';
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
import {
	hasPositiveWalletBalance,
	retireFundWalletDistributions,
} from '@/services/wallets/fund-distribution/retirement';
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

function serializeConfig(config: { id: string; enabled: boolean; batchWindowMs: number }) {
	return {
		id: config.id,
		enabled: config.enabled,
		batchWindowMs: config.batchWindowMs,
	};
}

export const getFundWalletEndpointGet = adminAuthenticatedEndpointFactory.build({
	method: 'get',
	input: getFundWalletSchemaInput,
	output: getFundWalletSchemaOutput,
	handler: async ({ input, ctx }) => {
		if (!input.id && !input.paymentSourceId) {
			throw createHttpError(400, 'Either id or paymentSourceId must be provided');
		}

		const wallets = await prisma.hotWallet.findMany({
			where: {
				// Admin keys currently carry every network and no wallet scope, so
				// these filters are defense-in-depth, matching the sibling wallet
				// endpoints in case this ever moves to a narrower factory.
				AND: [buildHotWalletScopeFilter(ctx.walletScopeIds), ...(input.id ? [{ id: input.id }] : [])],
				...(input.paymentSourceId ? { paymentSourceId: input.paymentSourceId } : {}),
				type: HotWalletType.Funding,
				deletedAt: null,
				PaymentSource: { deletedAt: null, network: { in: ctx.networkLimit } },
			},
			orderBy: { createdAt: 'asc' },
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
						topupEnabled: true,
						topupAmount: true,
						status: true,
						lastKnownAmount: true,
						lastCheckedAt: true,
						lastAlertedAt: true,
					},
				},
				FundDistributionConfig: {
					select: { id: true, enabled: true, batchWindowMs: true },
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

		return {
			FundWallets: wallets.map((wallet) => ({
				id: wallet.id,
				walletAddress: wallet.walletAddress,
				walletVkey: wallet.walletVkey,
				note: wallet.note ?? null,
				paymentSourceId: wallet.paymentSourceId,
				lockedAt: wallet.lockedAt ?? null,
				LowBalanceSummary: serializeLowBalanceSummary(wallet.LowBalanceRules),
				FundDistributionConfig: wallet.FundDistributionConfig ? serializeConfig(wallet.FundDistributionConfig) : null,
				pendingRequestCount: wallet._count.FundDistributionsSent,
			})),
		};
	},
});

export const postFundWalletEndpointPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: postFundWalletSchemaInput,
	output: postFundWalletSchemaOutput,
	handler: async ({ input, ctx }) => {
		const paymentSource = await prisma.paymentSource.findUnique({
			where: { id: input.paymentSourceId, deletedAt: null },
			select: { id: true, network: true },
		});

		if (!paymentSource) {
			throw createHttpError(404, 'Payment source not found');
		}
		await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, paymentSource.network);

		// A payment source may have several fund wallets (redundancy / capacity):
		// any of them can fund any shortage, so a second one is allowed. The only
		// hard constraint left is walletVkey uniqueness among active wallets, so
		// the same mnemonic cannot back two live fund wallets. A fund wallet holds
		// no per-asset policy anymore: the top-up trigger and amount live on each
		// hot wallet's low-balance rule.

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
								},
								select: { id: true, enabled: true, batchWindowMs: true },
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
				// The only remaining uniqueness constraint is walletVkey among active
				// wallets: the same mnemonic cannot back two live wallets anywhere in
				// the system. Multiple fund wallets per source are allowed, but each
				// needs its own mnemonic.
				throw createHttpError(
					409,
					'This wallet is already registered. A wallet mnemonic can only back one wallet, so each fund wallet needs its own mnemonic.',
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
	handler: async ({ input, ctx }) => {
		if (input.enabled == null && input.batchWindowMs == null) {
			throw createHttpError(400, 'No fund wallet changes requested');
		}

		const wallet = await prisma.hotWallet.findFirst({
			where: {
				AND: [buildHotWalletScopeFilter(ctx.walletScopeIds), { id: input.id }],
				type: HotWalletType.Funding,
				deletedAt: null,
				PaymentSource: { deletedAt: null, network: { in: ctx.networkLimit } },
			},
			select: { id: true, FundDistributionConfig: { select: { id: true } } },
		});

		if (!wallet) {
			throw createHttpError(404, 'Fund wallet not found');
		}

		const configId = wallet.FundDistributionConfig?.id;
		if (configId == null) {
			throw createHttpError(404, 'Fund wallet has no distribution config');
		}

		const updated = await retryOnSerializationConflict(
			() =>
				prisma.$transaction(
					async (tx) => {
						// A fund wallet holds no per-asset policy anymore: patching it only
						// toggles it as a funding source and adjusts its batch cadence.
						return tx.fundDistributionConfig.update({
							where: { id: configId },
							data: {
								...(input.enabled != null ? { enabled: input.enabled } : {}),
								...(input.batchWindowMs != null ? { batchWindowMs: input.batchWindowMs } : {}),
							},
							select: { id: true, enabled: true, batchWindowMs: true },
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
	handler: async ({ input, ctx }) => {
		const wallet = await prisma.hotWallet.findFirst({
			where: {
				AND: [buildHotWalletScopeFilter(ctx.walletScopeIds), { id: input.id }],
				type: HotWalletType.Funding,
				deletedAt: null,
				PaymentSource: { deletedAt: null, network: { in: ctx.networkLimit } },
			},
			select: {
				id: true,
				paymentSourceId: true,
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

			let balanceMap: Map<string, bigint>;
			try {
				balanceMap = await fetchAddressBalanceMap({
					network: wallet.PaymentSource.network,
					rpcProviderApiKey,
					address: wallet.walletAddress,
				});
			} catch {
				// Balance unknown (indexer down). Deleting blind could strand funds,
				// so make the operator choose rather than guessing for them.
				throw createHttpError(
					503,
					'Could not check the fund wallet balance before deleting. Retry, or pass force=true to delete without the check.',
				);
			}

			if (hasPositiveWalletBalance(balanceMap)) {
				throw createHttpError(
					409,
					'Fund wallet still holds ADA or native assets. Withdraw every asset first — after deletion the ' +
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

						await retireFundWalletDistributions(tx, {
							fundWalletId: input.id,
							paymentSourceId: wallet.paymentSourceId,
						});

						return true;
					},
					{ isolationLevel: 'Serializable' },
				),
			{ label: 'fund-wallet-delete' },
		);

		if (!didDelete) {
			// The guarded updateMany claims zero rows for two distinct reasons:
			// a concurrent request already soft-deleted the wallet (missing row),
			// or a distribution claimed the wallet between the pre-check and here
			// (a real conflict). Report the one that actually happened.
			const current = await prisma.hotWallet.findUnique({
				where: { id: input.id },
				select: { deletedAt: true },
			});
			if (current == null || current.deletedAt != null) {
				throw createHttpError(404, 'Fund wallet not found');
			}
			throw createHttpError(409, 'Fund wallet has a distribution in flight. Wait for it to settle before deleting.');
		}

		return { id: input.id };
	},
});
