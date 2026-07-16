import { adminAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { logger } from '@masumi/payment-core/logger';
import { prisma } from '@masumi/payment-core/db';
import createHttpError from 'http-errors';
import { CONSTANTS } from '@masumi/payment-core/config';
import { HotWalletType, FundDistributionStatus, Prisma } from '@/generated/prisma/client';
import { encrypt } from '@/utils/security/encryption';
import { resolvePaymentKeyHash } from '@meshsdk/core';
import { generateOfflineWallet } from '@/utils/generator/wallet-generator';
import { fetchAddressBalanceMap } from '@/services/shared/address-balance';
import { walletLowBalanceMonitorService, serializeLowBalanceSummary } from '@/services/wallets';
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

/**
 * Reject a topup that could never produce a valid output.
 *
 * Every distribution becomes one tx output, so a topupAmount below Cardano's
 * min-UTxO makes `build()` throw every time: the batch fails, the requests are
 * re-created next cycle, and it loops every 30s with a FAILED webhook each
 * round. Cheap to catch here; impossible to recover from downstream.
 */
function assertTopupAboveMinUtxo(topupAmount: bigint) {
	if (topupAmount < CONSTANTS.MIN_TOPUP_LOVELACE) {
		throw createHttpError(
			400,
			`topupAmount must be at least ${CONSTANTS.MIN_TOPUP_LOVELACE.toString()} lovelace; ` +
				'a smaller output cannot satisfy the Cardano min-UTxO requirement',
		);
	}
}

function serializeConfig(config: {
	id: string;
	enabled: boolean;
	warningThreshold: bigint;
	criticalThreshold: bigint;
	topupAmount: bigint;
	batchWindowMs: number;
}) {
	return {
		id: config.id,
		enabled: config.enabled,
		warningThreshold: config.warningThreshold.toString(),
		criticalThreshold: config.criticalThreshold.toString(),
		topupAmount: config.topupAmount.toString(),
		batchWindowMs: config.batchWindowMs,
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
						warningThreshold: true,
						criticalThreshold: true,
						topupAmount: true,
						batchWindowMs: true,
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

		const warningThreshold = BigInt(input.warningThreshold);
		const criticalThreshold = BigInt(input.criticalThreshold);
		const topupAmount = BigInt(input.topupAmount);

		if (criticalThreshold >= warningThreshold) {
			throw createHttpError(400, 'criticalThreshold must be less than warningThreshold');
		}
		assertTopupAboveMinUtxo(topupAmount);

		// A typo'd or truncated phrase is ordinary user input, not an exception:
		// MeshWallet throws a bare bip39 Error, which would otherwise surface as a
		// 500 plus an error-level log and a business-error metric.
		let address: string | undefined;
		try {
			const mnemonicWords = input.walletMnemonic.trim().split(/\s+/);
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
		const encryptedMnemonic = encrypt(input.walletMnemonic);

		let result;
		try {
			result = await prisma.$transaction(async (tx) => {
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
						warningThreshold,
						criticalThreshold,
						topupAmount,
						batchWindowMs: input.batchWindowMs ?? CONSTANTS.FUND_DISTRIBUTION_DEFAULT_BATCH_WINDOW_MS,
					},
				});

				return { hotWallet, config };
			});
		} catch (error) {
			// HotWallet.walletVkey is globally unique, not per payment source, so the
			// same mnemonic cannot back two wallets anywhere in the system. The
			// natural operator move -- reuse one treasury mnemonic for the V1 and the
			// V2 source -- lands here. Without this it surfaced as a raw Prisma error
			// and a 500, which reads as a bug rather than a constraint.
			if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
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
			select: {
				id: true,
				FundDistributionConfig: { select: { id: true, warningThreshold: true, criticalThreshold: true } },
			},
		});

		if (!wallet) {
			throw createHttpError(404, 'Fund wallet not found');
		}

		if (!wallet.FundDistributionConfig) {
			throw createHttpError(404, 'Fund wallet has no distribution config');
		}

		const newWarning =
			input.warningThreshold != null ? BigInt(input.warningThreshold) : wallet.FundDistributionConfig.warningThreshold;
		const newCritical =
			input.criticalThreshold != null
				? BigInt(input.criticalThreshold)
				: wallet.FundDistributionConfig.criticalThreshold;

		if (newCritical >= newWarning) {
			throw createHttpError(400, 'criticalThreshold must be less than warningThreshold');
		}
		// Enforced on update too, or the floor is trivially bypassed by creating a
		// valid wallet and editing the amount down afterwards.
		if (input.topupAmount != null) {
			assertTopupAboveMinUtxo(BigInt(input.topupAmount));
		}

		const updated = await prisma.fundDistributionConfig.update({
			where: { id: wallet.FundDistributionConfig.id },
			data: {
				...(input.enabled != null ? { enabled: input.enabled } : {}),
				...(input.warningThreshold != null ? { warningThreshold: BigInt(input.warningThreshold) } : {}),
				...(input.criticalThreshold != null ? { criticalThreshold: BigInt(input.criticalThreshold) } : {}),
				...(input.topupAmount != null ? { topupAmount: BigInt(input.topupAmount) } : {}),
				...(input.batchWindowMs != null ? { batchWindowMs: input.batchWindowMs } : {}),
			},
		});

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
				PaymentSource: {
					select: { network: true, PaymentSourceConfig: { select: { rpcProviderApiKey: true } } },
				},
			},
		});

		if (!wallet) {
			throw createHttpError(404, 'Fund wallet not found');
		}

		// Refuse to strand funds. Every read path filters `deletedAt: null`, so
		// once soft-deleted the mnemonic is unreachable through the API and the
		// balance is recoverable only with DB access plus the ENCRYPTION_KEY.
		// `force` exists for the case where the operator knows the funds are gone
		// or accepts the loss — but it must be a deliberate act, not the default.
		if (!input.force) {
			const rpcProviderApiKey = wallet.PaymentSource.PaymentSourceConfig?.rpcProviderApiKey;
			if (rpcProviderApiKey) {
				try {
					const balanceMap = await fetchAddressBalanceMap({
						network: wallet.PaymentSource.network,
						rpcProviderApiKey,
						address: wallet.walletAddress,
					});
					const lovelace = balanceMap.get('lovelace') ?? 0n;
					if (lovelace > 0n) {
						throw createHttpError(
							409,
							`Fund wallet still holds ${lovelace.toString()} lovelace. Withdraw it first — after deletion the ` +
								'mnemonic can no longer be exported through the API. Pass force=true to delete anyway.',
						);
					}
				} catch (error) {
					if (createHttpError.isHttpError(error)) throw error;
					// Balance unknown (indexer down). Deleting blind could strand funds,
					// so make the operator choose rather than guessing for them.
					throw createHttpError(
						503,
						'Could not check the fund wallet balance before deleting. Retry, or pass force=true to delete without the check.',
					);
				}
			}
		}

		await prisma.$transaction(async (tx) => {
			await tx.fundDistributionConfig.updateMany({
				where: { hotWalletId: input.id },
				data: { enabled: false },
			});

			// Cancel any outstanding distribution requests so the scheduler stops picking them up
			await tx.fundDistributionRequest.updateMany({
				where: {
					fundWalletId: input.id,
					status: { in: [FundDistributionStatus.Pending, FundDistributionStatus.Submitted] },
				},
				data: {
					status: FundDistributionStatus.Failed,
					error: 'Fund wallet was deleted',
				},
			});

			await tx.hotWallet.update({
				where: { id: input.id },
				data: { deletedAt: new Date() },
			});
		});

		return { id: input.id };
	},
});
