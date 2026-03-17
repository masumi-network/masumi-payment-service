import { webhookQueueService } from './queue.service';
import { logger } from '@/utils/logger';
import { prisma } from '@/utils/db';
import { WebhookEventType } from '@/generated/prisma/client';
import type { WebhookPayloadDataByEvent } from '@/types/webhook-payloads';
import { decodeBlockchainIdentifier } from '@/utils/generator/blockchain-identifier-generator';

type PaymentWebhookEvent = 'PAYMENT_ON_CHAIN_STATUS_CHANGED' | 'PAYMENT_ON_ERROR';
type PurchaseWebhookEvent = 'PURCHASE_ON_CHAIN_STATUS_CHANGED' | 'PURCHASE_ON_ERROR';
type PaymentWebhookData = WebhookPayloadDataByEvent<PaymentWebhookEvent>;
type PurchaseWebhookData = WebhookPayloadDataByEvent<PurchaseWebhookEvent>;
type WalletLowBalanceWebhookData = WebhookPayloadDataByEvent<'WALLET_LOW_BALANCE'>;

class WebhookEventsService {
	private async queryPurchaseForWebhook(purchaseId: string) {
		return prisma.purchaseRequest.findUnique({
			where: { id: purchaseId },
			include: {
				SellerWallet: true,
				SmartContractWallet: { where: { deletedAt: null } },
				PaidFunds: true,
				NextAction: true,
				PaymentSource: true,
				CurrentTransaction: true,
				WithdrawnForSeller: true,
				WithdrawnForBuyer: true,
				ActionHistory: { orderBy: { createdAt: 'desc' } },
				TransactionHistory: { orderBy: { createdAt: 'desc' } },
			},
		});
	}

	private async queryPaymentForWebhook(paymentId: string) {
		return prisma.paymentRequest.findUnique({
			where: { id: paymentId },
			include: {
				BuyerWallet: true,
				SmartContractWallet: { where: { deletedAt: null } },
				PaymentSource: true,
				RequestedFunds: { include: { AgentFixedPricing: true } },
				NextAction: true,
				CurrentTransaction: true,
				WithdrawnForSeller: true,
				WithdrawnForBuyer: true,
				ActionHistory: { orderBy: { createdAt: 'desc' } },
				TransactionHistory: { orderBy: { createdAt: 'desc' } },
			},
		});
	}

	private formatPurchaseForWebhook(
		purchase: NonNullable<Awaited<ReturnType<typeof this.queryPurchaseForWebhook>>>,
	): PurchaseWebhookData {
		return {
			...purchase,
			agentIdentifier: decodeBlockchainIdentifier(purchase.blockchainIdentifier)?.agentIdentifier ?? null,
			totalBuyerCardanoFees: Number(purchase.totalBuyerCardanoFees.toString()) / 1_000_000,
			totalSellerCardanoFees: Number(purchase.totalSellerCardanoFees.toString()) / 1_000_000,
			PaidFunds: (purchase.PaidFunds as Array<{ unit: string; amount: bigint }>).map((amount) => ({
				...amount,
				amount: amount.amount.toString(),
			})),
			WithdrawnForSeller: (purchase.WithdrawnForSeller as Array<{ unit: string; amount: bigint }>).map((amount) => ({
				unit: amount.unit,
				amount: amount.amount.toString(),
			})),
			WithdrawnForBuyer: (purchase.WithdrawnForBuyer as Array<{ unit: string; amount: bigint }>).map((amount) => ({
				unit: amount.unit,
				amount: amount.amount.toString(),
			})),
			CurrentTransaction: purchase.CurrentTransaction
				? {
						...purchase.CurrentTransaction,
						fees: purchase.CurrentTransaction.fees?.toString() ?? null,
					}
				: null,
			TransactionHistory:
				purchase.TransactionHistory != null
					? purchase.TransactionHistory.map((transaction) => ({
							...transaction,
							fees: transaction.fees?.toString() ?? null,
						}))
					: null,
			collateralReturnLovelace: purchase.collateralReturnLovelace?.toString() ?? null,
			payByTime: purchase.payByTime?.toString() ?? null,
			submitResultTime: purchase.submitResultTime.toString(),
			unlockTime: purchase.unlockTime.toString(),
			externalDisputeUnlockTime: purchase.externalDisputeUnlockTime.toString(),
			cooldownTime: Number(purchase.buyerCoolDownTime),
			cooldownTimeOtherParty: Number(purchase.sellerCoolDownTime),
		};
	}

	private formatPaymentForWebhook(
		payment: NonNullable<Awaited<ReturnType<typeof this.queryPaymentForWebhook>>>,
	): PaymentWebhookData {
		return {
			...payment,
			agentIdentifier: decodeBlockchainIdentifier(payment.blockchainIdentifier)?.agentIdentifier ?? null,
			totalBuyerCardanoFees: Number(payment.totalBuyerCardanoFees.toString()) / 1_000_000,
			totalSellerCardanoFees: Number(payment.totalSellerCardanoFees.toString()) / 1_000_000,
			submitResultTime: payment.submitResultTime.toString(),
			cooldownTime: Number(payment.sellerCoolDownTime),
			cooldownTimeOtherParty: Number(payment.buyerCoolDownTime),
			payByTime: payment.payByTime?.toString() ?? null,
			unlockTime: payment.unlockTime.toString(),
			externalDisputeUnlockTime: payment.externalDisputeUnlockTime.toString(),
			collateralReturnLovelace: payment.collateralReturnLovelace?.toString() ?? null,
			RequestedFunds: (payment.RequestedFunds as Array<{ unit: string; amount: bigint }>).map((amount) => ({
				...amount,
				amount: amount.amount.toString(),
			})),
			WithdrawnForSeller: (payment.WithdrawnForSeller as Array<{ unit: string; amount: bigint }>).map((amount) => ({
				unit: amount.unit,
				amount: amount.amount.toString(),
			})),
			WithdrawnForBuyer: (payment.WithdrawnForBuyer as Array<{ unit: string; amount: bigint }>).map((amount) => ({
				unit: amount.unit,
				amount: amount.amount.toString(),
			})),
			CurrentTransaction: payment.CurrentTransaction
				? {
						...payment.CurrentTransaction,
						fees: payment.CurrentTransaction.fees?.toString() ?? null,
					}
				: null,
			TransactionHistory:
				payment.TransactionHistory != null
					? payment.TransactionHistory.map((transaction) => ({
							...transaction,
							fees: transaction.fees?.toString() ?? null,
						}))
					: null,
		};
	}

	private async triggerGenericWebhook(
		eventType: PurchaseWebhookEvent | PaymentWebhookEvent,
		entityId: string,
		entityType: 'purchase' | 'payment',
	): Promise<void> {
		try {
			let formattedData: PurchaseWebhookData | PaymentWebhookData;
			let blockchainIdentifier: string;
			let paymentSourceId: string;

			if (entityType === 'purchase') {
				const purchase = await this.queryPurchaseForWebhook(entityId);
				if (!purchase) {
					logger.error('Purchase not found for webhook trigger', {
						purchaseId: entityId,
					});
					return;
				}
				formattedData = this.formatPurchaseForWebhook(purchase);
				blockchainIdentifier = purchase.blockchainIdentifier;
				paymentSourceId = purchase.PaymentSource.id;
			} else {
				const payment = await this.queryPaymentForWebhook(entityId);
				if (!payment) {
					logger.error('Payment not found for webhook trigger', {
						paymentId: entityId,
					});
					return;
				}
				formattedData = this.formatPaymentForWebhook(payment);
				blockchainIdentifier = payment.blockchainIdentifier;
				paymentSourceId = payment.PaymentSource.id;
			}

			await webhookQueueService.queueWebhook(eventType, formattedData, blockchainIdentifier, paymentSourceId);

			logger.info(`${String(eventType)} webhook triggered`, {
				[`${entityType}Id`]: entityId,
				blockchainIdentifier,
			});
		} catch (error) {
			logger.error(`Failed to trigger ${String(eventType)} webhook`, {
				[`${entityType}Id`]: entityId,
				error: error instanceof Error ? error.message : 'Unknown error',
			});
		}
	}

	async triggerPurchaseOnChainStatusChanged(purchaseId: string): Promise<void> {
		await this.triggerGenericWebhook(WebhookEventType.PURCHASE_ON_CHAIN_STATUS_CHANGED, purchaseId, 'purchase');
	}

	async triggerPaymentOnChainStatusChanged(paymentId: string): Promise<void> {
		await this.triggerGenericWebhook(WebhookEventType.PAYMENT_ON_CHAIN_STATUS_CHANGED, paymentId, 'payment');
	}

	async triggerPurchaseOnError(purchaseId: string): Promise<void> {
		await this.triggerGenericWebhook(WebhookEventType.PURCHASE_ON_ERROR, purchaseId, 'purchase');
	}

	async triggerPaymentOnError(paymentId: string): Promise<void> {
		await this.triggerGenericWebhook(WebhookEventType.PAYMENT_ON_ERROR, paymentId, 'payment');
	}

	async triggerWalletLowBalance(payload: WalletLowBalanceWebhookData): Promise<void> {
		try {
			await webhookQueueService.queueWebhook(
				WebhookEventType.WALLET_LOW_BALANCE,
				payload,
				payload.walletId,
				payload.paymentSourceId,
			);

			logger.info('WALLET_LOW_BALANCE webhook triggered', {
				walletId: payload.walletId,
				paymentSourceId: payload.paymentSourceId,
				assetUnit: payload.assetUnit,
				network: payload.network,
			});
		} catch (error) {
			logger.error('Failed to trigger WALLET_LOW_BALANCE webhook', {
				walletId: payload.walletId,
				error: error instanceof Error ? error.message : 'Unknown error',
			});
		}
	}
}

export const webhookEventsService = new WebhookEventsService();
