import { webhookQueueService } from './queue.service';
import { logger } from '@masumi/payment-core/logger';
import { prisma } from '@masumi/payment-core/db';
import { WebhookEventType } from '@/generated/prisma/client';
import type { Prisma } from '@/generated/prisma/client';
import type { WebhookPayloadDataByEvent } from '@/types/webhook-payloads';
import { decodeBlockchainIdentifier } from '@masumi/payment-core/blockchain-identifier';

type PaymentWebhookEvent = 'PAYMENT_ON_CHAIN_STATUS_CHANGED' | 'PAYMENT_ON_ERROR';
type PurchaseWebhookEvent = 'PURCHASE_ON_CHAIN_STATUS_CHANGED' | 'PURCHASE_ON_ERROR';
type PaymentWebhookData = WebhookPayloadDataByEvent<PaymentWebhookEvent>;
type PurchaseWebhookData = WebhookPayloadDataByEvent<PurchaseWebhookEvent>;
type WalletLowBalanceWebhookData = WebhookPayloadDataByEvent<'WALLET_LOW_BALANCE'>;
type X402PaymentWebhookEvent = 'X402_PAYMENT_SETTLED' | 'X402_PAYMENT_FAILED';
type X402PaymentWebhookData = WebhookPayloadDataByEvent<X402PaymentWebhookEvent>;
type X402WalletLowBalanceWebhookData = WebhookPayloadDataByEvent<'X402_WALLET_LOW_BALANCE'>;
type PaymentWebhookQueryClient = Pick<Prisma.TransactionClient, 'paymentRequest'>;
type PurchaseWebhookQueryClient = Pick<Prisma.TransactionClient, 'purchaseRequest'>;

class WebhookEventsService {
	private async queryPurchaseForWebhook(purchaseId: string, client: PurchaseWebhookQueryClient = prisma) {
		return client.purchaseRequest.findUnique({
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

	private async queryPaymentForWebhook(paymentId: string, client: PaymentWebhookQueryClient = prisma) {
		return client.paymentRequest.findUnique({
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
			let paymentSourceType: string;

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
				paymentSourceType = purchase.PaymentSource.paymentSourceType;
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
				paymentSourceType = payment.PaymentSource.paymentSourceType;
			}

			await webhookQueueService.queueWebhook(eventType, formattedData, blockchainIdentifier, paymentSourceId);

			logger.info(`${String(eventType)} webhook triggered`, {
				[`${entityType}Id`]: entityId,
				blockchainIdentifier,
				paymentSourceType,
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

	async queuePurchaseOnErrorInTransaction(tx: Prisma.TransactionClient, purchaseId: string): Promise<void> {
		const purchase = await this.queryPurchaseForWebhook(purchaseId, tx);
		if (purchase == null) {
			throw new Error(`Purchase ${purchaseId} not found while queuing error webhook`);
		}
		await webhookQueueService.queueWebhookInTransaction(
			tx,
			WebhookEventType.PURCHASE_ON_ERROR,
			this.formatPurchaseForWebhook(purchase),
			purchase.blockchainIdentifier,
			purchase.PaymentSource.id,
		);
	}

	async queuePaymentOnErrorInTransaction(tx: Prisma.TransactionClient, paymentId: string): Promise<void> {
		const payment = await this.queryPaymentForWebhook(paymentId, tx);
		if (payment == null) {
			throw new Error(`Payment ${paymentId} not found while queuing error webhook`);
		}
		await webhookQueueService.queueWebhookInTransaction(
			tx,
			WebhookEventType.PAYMENT_ON_ERROR,
			this.formatPaymentForWebhook(payment),
			payment.blockchainIdentifier,
			payment.PaymentSource.id,
		);
	}

	// Fund-distribution lifecycle events are queued exclusively through the
	// strict in-transaction variants below: the webhook row must commit (or
	// roll back) with the domain transition it describes. There is no
	// best-effort post-commit trigger path on purpose.

	async queueFundDistributionSent(
		tx: Prisma.TransactionClient,
		payload: WebhookPayloadDataByEvent<'FUND_DISTRIBUTION_SENT'>,
		paymentSourceId: string,
	): Promise<void> {
		await webhookQueueService.queueWebhookInTransaction(
			tx,
			WebhookEventType.FUND_DISTRIBUTION_SENT,
			payload,
			payload.fundWalletId,
			paymentSourceId,
		);
	}

	async queueFundDistributionConfirmed(
		tx: Prisma.TransactionClient,
		payload: WebhookPayloadDataByEvent<'FUND_DISTRIBUTION_CONFIRMED'>,
		paymentSourceId: string,
	): Promise<void> {
		await webhookQueueService.queueWebhookInTransaction(
			tx,
			WebhookEventType.FUND_DISTRIBUTION_CONFIRMED,
			payload,
			payload.fundWalletId,
			paymentSourceId,
		);
	}

	async queueFundDistributionFailed(
		tx: Prisma.TransactionClient,
		payload: WebhookPayloadDataByEvent<'FUND_DISTRIBUTION_FAILED'>,
		paymentSourceId: string,
	): Promise<void> {
		await webhookQueueService.queueWebhookInTransaction(
			tx,
			WebhookEventType.FUND_DISTRIBUTION_FAILED,
			payload,
			payload.fundWalletId,
			paymentSourceId,
		);
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
	// x402 (EVM) rail events. These are not tied to a Cardano PaymentSource, so the
	// paymentSourceId selector is left undefined and global webhook endpoints receive them.
	async triggerX402Payment(success: boolean, payload: X402PaymentWebhookData): Promise<void> {
		const eventType: X402PaymentWebhookEvent = success
			? WebhookEventType.X402_PAYMENT_SETTLED
			: WebhookEventType.X402_PAYMENT_FAILED;
		try {
			await webhookQueueService.queueWebhook(eventType, payload, payload.attemptId, undefined);
		} catch (error) {
			logger.error('Failed to trigger x402 payment webhook', {
				attemptId: payload.attemptId,
				eventType,
				error: error instanceof Error ? error.message : 'Unknown error',
			});
		}
	}

	async triggerX402WalletLowBalance(payload: X402WalletLowBalanceWebhookData): Promise<void> {
		try {
			await webhookQueueService.queueWebhook(
				WebhookEventType.X402_WALLET_LOW_BALANCE,
				payload,
				payload.evmWalletId,
				undefined,
			);
		} catch (error) {
			logger.error('Failed to trigger X402_WALLET_LOW_BALANCE webhook', {
				evmWalletId: payload.evmWalletId,
				error: error instanceof Error ? error.message : 'Unknown error',
			});
		}
	}
}

export const webhookEventsService = new WebhookEventsService();
