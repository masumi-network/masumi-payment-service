import { WebhookDeliveryStatus, WebhookEventType, WebhookFormat } from '@/generated/prisma/client';
import { WEBHOOK_TEST_EVENT_TYPE } from '@/types/webhook-constants';
import type { StoredWebhookPayload, WebhookSendPayload, WebhookTestPayload } from '@/types/webhook-payloads';
import { prisma } from '@/utils/db';
import { logger } from '@/utils/logger';
import { getOwnPlainObject, getOwnString, isPlainObject } from '@/utils/object-properties';
import { decryptWebhookAuthTokenSafe, decryptWebhookUrlForDelivery } from '@/utils/security/webhook-secrets';

interface WebhookDeliveryResult {
	success: boolean;
	responseCode?: number;
	errorMessage?: string;
	durationMs: number;
}

/**
 * Service for sending individual webhook HTTP requests
 */
class WebhookSenderService {
	private static readonly REQUEST_TIMEOUT = 10000;
	private static readonly USER_AGENT = 'Masumi-Webhook/1.0';
	private static readonly EVENT_TYPES = new Set<string>(Object.values(WebhookEventType));
	private static readonly LOVELACE_DECIMALS = 1_000_000n;
	private static readonly MAINNET_USDCX_UNIT = '1f3aec8bfe7ea4fe14c5f121e2a92e301afe414147860d557cac7e345553444378';
	private static readonly MAINNET_USDM_UNIT =
		'c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad0014df105553444d';
	private static readonly PREPROD_USDM_UNIT =
		'16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d';

	/**
	 * Send a webhook to a specific URL
	 */
	async sendWebhook(
		url: string,
		format: WebhookFormat,
		authToken: string | null,
		payload: WebhookSendPayload,
	): Promise<WebhookDeliveryResult> {
		const startTime = Date.now();

		try {
			logger.info('Sending webhook', {
				url,
				format,
				event_type: payload.event_type,
			});

			const request = this.buildRequest(format, authToken, payload);
			const response = await fetch(url, {
				method: 'POST',
				headers: request.headers,
				body: request.body,
				signal: AbortSignal.timeout(WebhookSenderService.REQUEST_TIMEOUT),
			});

			const durationMs = Date.now() - startTime;

			if (response.ok) {
				logger.info('Webhook delivered successfully', {
					url,
					format,
					event_type: payload.event_type,
					status_code: response.status,
					duration_ms: durationMs,
				});

				return {
					success: true,
					responseCode: response.status,
					durationMs,
				};
			} else {
				const errorMessage = `HTTP ${response.status}: ${response.statusText}`;

				logger.warn('Webhook delivery failed', {
					url,
					format,
					event_type: payload.event_type,
					status_code: response.status,
					error: errorMessage,
					duration_ms: durationMs,
				});

				return {
					success: false,
					responseCode: response.status,
					errorMessage,
					durationMs,
				};
			}
		} catch (error) {
			const durationMs = Date.now() - startTime;
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';

			// Check if this is a timeout or HTTP connection error
			const isTimeoutError = this.isTimeoutOrNetworkError(error);

			if (isTimeoutError) {
				// Log timeout/network errors as warnings (expected external issues)
				logger.warn('Webhook delivery timeout/network error', {
					url,
					format,
					event_type: payload.event_type,
					error: errorMessage,
					duration_ms: durationMs,
				});
			} else {
				// Log other errors as errors (unexpected application issues)
				logger.error('Webhook delivery error', {
					url,
					format,
					event_type: payload.event_type,
					error: errorMessage,
					duration_ms: durationMs,
				});
			}

			return {
				success: false,
				errorMessage,
				durationMs,
			};
		}
	}

	async sendTestWebhook(
		webhook: {
			id: string;
			url: string;
			format: WebhookFormat;
			authToken: string | null;
			name: string | null;
			paymentSourceId: string | null;
		},
		triggeredByApiKeyId: string,
		serviceName: string,
	): Promise<WebhookDeliveryResult> {
		const decryptedUrl = decryptWebhookUrlForDelivery(webhook.url);
		if (decryptedUrl == null) {
			return {
				success: false,
				errorMessage: 'Webhook URL decryption failed',
				durationMs: 0,
			};
		}

		const decryptedAuthToken = decryptWebhookAuthTokenSafe(webhook.authToken);
		if (webhook.format === WebhookFormat.EXTENDED && decryptedAuthToken == null) {
			return {
				success: false,
				errorMessage:
					webhook.authToken == null
						? 'Extended webhook endpoints require an auth token'
						: 'Webhook auth token decryption failed',
				durationMs: 0,
			};
		}

		const payload: WebhookTestPayload = {
			event_type: WEBHOOK_TEST_EVENT_TYPE,
			service_name: serviceName,
			timestamp: new Date().toISOString(),
			webhook_id: webhook.id,
			data: {
				message: 'This is a test webhook delivery from Masumi.',
				webhookName: webhook.name,
				webhookFormat: webhook.format,
				paymentSourceId: webhook.paymentSourceId,
				triggeredByApiKeyId,
			},
		};

		const result = await this.sendWebhook(decryptedUrl, webhook.format, decryptedAuthToken, payload);

		if (result.success) {
			await this.updateWebhookSuccessTracking(webhook.id);
		}

		return result;
	}

	/**
	 * Process a webhook delivery from the database queue
	 */
	async processWebhookDelivery(deliveryId: string): Promise<void> {
		const delivery = await prisma.webhookDelivery.findUnique({
			where: { id: deliveryId },
			include: {
				WebhookEndpoint: true,
			},
		});

		if (!delivery) {
			logger.warn('Webhook delivery not found', { delivery_id: deliveryId });
			return;
		}

		if (!delivery.WebhookEndpoint.isActive) {
			logger.info('Skipping delivery for inactive webhook', {
				delivery_id: deliveryId,
				webhook_id: delivery.webhookEndpointId,
			});

			await prisma.webhookDelivery.update({
				where: { id: deliveryId },
				data: {
					status: WebhookDeliveryStatus.Cancelled as WebhookDeliveryStatus,
				},
			});
			return;
		}

		if (delivery.attempts >= delivery.maxAttempts) {
			logger.warn('Webhook delivery exceeded max attempts', {
				delivery_id: deliveryId,
				attempts: delivery.attempts,
				max_attempts: delivery.maxAttempts,
			});

			await prisma.webhookDelivery.update({
				where: { id: deliveryId },
				data: { status: WebhookDeliveryStatus.Failed as WebhookDeliveryStatus },
			});

			// Update webhook endpoint failure tracking
			await this.updateWebhookFailureTracking(delivery.webhookEndpointId);
			return;
		}

		const updatedDelivery = await prisma.webhookDelivery.update({
			where: { id: deliveryId },
			data: {
				attempts: { increment: 1 },
			},
			select: {
				attempts: true,
			},
		});

		if (!this.isStoredWebhookPayload(delivery.payload)) {
			logger.error('Webhook delivery payload is invalid', {
				delivery_id: deliveryId,
				webhook_id: delivery.webhookEndpointId,
			});

			await prisma.webhookDelivery.update({
				where: { id: deliveryId },
				data: {
					status: WebhookDeliveryStatus.Failed as WebhookDeliveryStatus,
					errorMessage: 'Invalid webhook payload stored in queue',
				},
			});
			return;
		}

		const decryptedUrl = decryptWebhookUrlForDelivery(delivery.WebhookEndpoint.url);
		if (decryptedUrl == null) {
			await prisma.webhookDelivery.update({
				where: { id: deliveryId },
				data: {
					status: WebhookDeliveryStatus.Failed as WebhookDeliveryStatus,
					errorMessage: 'Webhook URL decryption failed',
				},
			});
			await this.updateWebhookFailureTracking(delivery.webhookEndpointId);
			return;
		}

		const decryptedAuthToken = decryptWebhookAuthTokenSafe(delivery.WebhookEndpoint.authToken);
		if (delivery.WebhookEndpoint.format === WebhookFormat.EXTENDED && decryptedAuthToken == null) {
			await prisma.webhookDelivery.update({
				where: { id: deliveryId },
				data: {
					status: WebhookDeliveryStatus.Failed as WebhookDeliveryStatus,
					errorMessage:
						delivery.WebhookEndpoint.authToken == null
							? 'Extended webhook endpoints require an auth token'
							: 'Webhook auth token decryption failed',
				},
			});
			await this.updateWebhookFailureTracking(delivery.webhookEndpointId);
			return;
		}

		const result = await this.sendWebhook(
			decryptedUrl,
			delivery.WebhookEndpoint.format,
			decryptedAuthToken,
			delivery.payload,
		);

		if (result.success) {
			await prisma.webhookDelivery.update({
				where: { id: deliveryId },
				data: {
					status: WebhookDeliveryStatus.Success as WebhookDeliveryStatus,
					responseCode: result.responseCode,
					deliveredAt: new Date(),
					durationMs: result.durationMs,
				},
			});

			// Update webhook endpoint success tracking
			await this.updateWebhookSuccessTracking(delivery.webhookEndpointId);
		} else {
			const nextRetryDelay = this.calculateRetryDelay(updatedDelivery.attempts);
			const nextRetryAt = new Date(Date.now() + nextRetryDelay);

			const isFinalAttempt = updatedDelivery.attempts >= delivery.maxAttempts;

			await prisma.webhookDelivery.update({
				where: { id: deliveryId },
				data: {
					status: isFinalAttempt
						? (WebhookDeliveryStatus.Failed as WebhookDeliveryStatus)
						: (WebhookDeliveryStatus.Retrying as WebhookDeliveryStatus),
					responseCode: result.responseCode,
					errorMessage: result.errorMessage,
					durationMs: result.durationMs,
					nextRetryAt: isFinalAttempt ? null : nextRetryAt,
				},
			});

			if (isFinalAttempt) {
				await this.updateWebhookFailureTracking(delivery.webhookEndpointId);
			}
		}
	}

	/**
	 * Calculate retry delay with exponential backoff
	 */
	private calculateRetryDelay(attemptNumber: number): number {
		const baseDelay = 30 * 1000;
		const maxDelay = 10 * 60 * 1000;

		const delay = Math.min(baseDelay * Math.pow(2, attemptNumber - 1), maxDelay);

		const jitter = Math.random() * 0.3 * delay;

		return Math.floor(delay + jitter);
	}

	/**
	 * Update webhook endpoint success tracking
	 */
	private async updateWebhookSuccessTracking(webhookEndpointId: string): Promise<void> {
		await prisma.webhookEndpoint.update({
			where: { id: webhookEndpointId },
			data: {
				lastSuccessAt: new Date(),
				consecutiveFailures: 0,
			},
		});
	}

	/**
	 * Check if the error is a timeout or HTTP error
	 */
	private isTimeoutOrNetworkError(error: unknown): boolean {
		if (!(error instanceof Error)) return false;

		const errorName = error.name.toLowerCase();
		const errorMessage = error.message.toLowerCase();

		// Check for timeout errors (from AbortSignal.timeout)
		if (errorName === 'aborterror' || errorName === 'timeouterror') {
			return true;
		}

		// Check for HTTP connection errors
		if (errorMessage.includes('fetch failed')) {
			return true;
		}

		return false;
	}

	private isStoredWebhookPayload(value: unknown): value is StoredWebhookPayload {
		if (!isPlainObject(value)) {
			return false;
		}

		const eventType = getOwnString(value, 'event_type');
		const timestamp = getOwnString(value, 'timestamp');
		const webhookId = getOwnString(value, 'webhook_id');
		const data = getOwnPlainObject(value, 'data');

		return (
			eventType !== undefined &&
			WebhookSenderService.EVENT_TYPES.has(eventType) &&
			timestamp !== undefined &&
			webhookId !== undefined &&
			data !== undefined
		);
	}

	private buildRequest(
		format: WebhookFormat,
		authToken: string | null,
		payload: WebhookSendPayload,
	): { headers: Record<string, string>; body: string } {
		switch (format) {
			case WebhookFormat.SLACK:
				return {
					headers: {
						'Content-Type': 'application/json',
						'User-Agent': WebhookSenderService.USER_AGENT,
					},
					body: JSON.stringify({
						text: this.buildCompactSummary(payload),
					}),
				};
			case WebhookFormat.GOOGLE_CHAT:
				return {
					headers: {
						'Content-Type': 'application/json; charset=UTF-8',
						'User-Agent': WebhookSenderService.USER_AGENT,
					},
					body: JSON.stringify({
						text: this.buildCompactSummary(payload),
					}),
				};
			case WebhookFormat.DISCORD:
				return {
					headers: {
						'Content-Type': 'application/json',
						'User-Agent': WebhookSenderService.USER_AGENT,
					},
					body: JSON.stringify({
						content: this.buildCompactSummary(payload),
					}),
				};
			case WebhookFormat.EXTENDED:
				if (authToken == null) {
					throw new Error('Extended webhook endpoints require an auth token');
				}

				return {
					headers: {
						'Content-Type': 'application/json',
						Authorization: `Bearer ${authToken}`,
						'X-Masumi-Event': payload.event_type,
						'X-Masumi-Timestamp': payload.timestamp,
						'User-Agent': WebhookSenderService.USER_AGENT,
					},
					body: JSON.stringify(payload),
				};
			default: {
				const unknownFormat: never = format;
				throw new Error(`Unsupported webhook format: ${String(unknownFormat)}`);
			}
		}
	}

	private buildCompactSummary(payload: WebhookSendPayload): string {
		const eventPresentation = this.getEventPresentation(payload.event_type);
		const lines = [`${eventPresentation.emoji} ${eventPresentation.title}`];
		if (payload.service_name) {
			lines.push(`🛰️ Service: ${payload.service_name}`);
		}

		if (payload.event_type === WEBHOOK_TEST_EVENT_TYPE) {
			lines.push('');
			this.appendDetailLine(lines, '💬', 'Message', payload.data.message);
			this.appendDetailLine(lines, '🔔', 'Webhook', payload.data.webhookName);
			this.appendDetailLine(lines, '🏦', 'Payment source', payload.data.paymentSourceId);
			this.appendDetailLine(lines, '🕒', 'Sent at', payload.timestamp);
			return lines.join('\n');
		}

		if (payload.event_type === WebhookEventType.WALLET_LOW_BALANCE) {
			lines.push('');
			this.appendDetailLine(lines, '👛', 'Wallet ID', payload.data.walletId);
			this.appendDetailLine(lines, '📬', 'Wallet address', payload.data.walletAddress);
			this.appendDetailLine(lines, '🏦', 'Payment source', payload.data.paymentSourceId);
			this.appendDetailLine(lines, '🌐', 'Network', payload.data.network);
			this.appendDetailLine(
				lines,
				'🎯',
				'Threshold',
				this.formatBalanceForDisplay(payload.data.thresholdAmount, payload.data.assetUnit),
			);
			this.appendDetailLine(
				lines,
				'💰',
				'New balance',
				this.formatBalanceForDisplay(payload.data.currentAmount, payload.data.assetUnit),
			);
			this.appendDetailLine(lines, '🕒', 'Checked at', payload.data.checkedAt);
			this.appendDetailLine(lines, '⏱️', 'Event time', payload.timestamp);
			return lines.join('\n');
		}

		if (payload.event_type === WebhookEventType.FUND_DISTRIBUTION_SENT) {
			lines.push('');
			this.appendDetailLine(lines, '🏦', 'Fund Wallet ID', payload.data.fundWalletId);
			this.appendDetailLine(lines, '📬', 'Fund Wallet address', payload.data.fundWalletAddress);
			this.appendDetailLine(lines, '🔗', 'Tx hash', payload.data.txHash);
			this.appendDetailLine(lines, '🌐', 'Network', payload.data.network);
			this.appendDetailLine(lines, '⏱️', 'Event time', payload.timestamp);
			return lines.join('\n');
		}

		lines.push('');
		this.appendDetailLine(lines, '🏷️', 'ID', payload.data.id);
		this.appendDetailLine(lines, '⛓️', 'Blockchain ID', payload.data.blockchainIdentifier);
		this.appendDetailLine(lines, '🏦', 'Payment source', payload.data.PaymentSource.id);
		this.appendDetailLine(lines, '🌐', 'Network', payload.data.PaymentSource.network);
		this.appendDetailLine(lines, '📍', 'On-chain state', payload.data.onChainState);
		this.appendDetailLine(lines, '➡️', 'Next action', payload.data.NextAction.requestedAction);
		this.appendDetailLine(lines, '⚠️', 'Error type', payload.data.NextAction.errorType);
		this.appendDetailLine(lines, '📝', 'Error note', payload.data.NextAction.errorNote);
		this.appendDetailLine(lines, '⏱️', 'Event time', payload.timestamp);

		return lines.join('\n');
	}

	private appendDetailLine(lines: string[], emoji: string, label: string, value: string | null | undefined): void {
		if (value == null || value === '') {
			return;
		}

		lines.push(`${emoji} ${label}: ${value}`);
	}

	private getEventPresentation(eventType: WebhookSendPayload['event_type']): {
		emoji: string;
		title: string;
	} {
		switch (eventType) {
			case WebhookEventType.PAYMENT_ON_CHAIN_STATUS_CHANGED:
				return { emoji: '💸', title: 'Payment status updated' };
			case WebhookEventType.PURCHASE_ON_CHAIN_STATUS_CHANGED:
				return { emoji: '🛒', title: 'Purchase status updated' };
			case WebhookEventType.PAYMENT_ON_ERROR:
				return { emoji: '🚨', title: 'Payment error' };
			case WebhookEventType.PURCHASE_ON_ERROR:
				return { emoji: '🚨', title: 'Purchase error' };
			case WebhookEventType.WALLET_LOW_BALANCE:
				return { emoji: '🪫', title: 'Wallet balance low' };
			case WebhookEventType.FUND_DISTRIBUTION_SENT:
				return { emoji: '💸', title: 'Fund distribution sent' };
			case WEBHOOK_TEST_EVENT_TYPE:
				return { emoji: '🧪', title: 'Test webhook delivery' };
			default:
				return { emoji: '🔔', title: eventType };
		}
	}

	private formatBalanceForDisplay(rawAmount: string, assetUnit: string): string {
		const assetLabel = this.getAssetLabel(assetUnit);
		if (!this.usesSixDecimals(assetUnit)) {
			return `${rawAmount} ${assetLabel}`;
		}

		return `${this.formatSixDecimalAmount(rawAmount)} ${assetLabel}`;
	}

	private usesSixDecimals(assetUnit: string): boolean {
		return (
			assetUnit === 'lovelace' ||
			assetUnit === WebhookSenderService.MAINNET_USDCX_UNIT ||
			assetUnit === WebhookSenderService.MAINNET_USDM_UNIT ||
			assetUnit === WebhookSenderService.PREPROD_USDM_UNIT
		);
	}

	private getAssetLabel(assetUnit: string): string {
		switch (assetUnit) {
			case '':
			case 'lovelace':
				return 'ADA';
			case WebhookSenderService.MAINNET_USDCX_UNIT:
				return 'USDCx';
			case WebhookSenderService.MAINNET_USDM_UNIT:
				return 'USDM';
			case WebhookSenderService.PREPROD_USDM_UNIT:
				return 'tUSDM';
			default:
				return this.decodeAssetName(assetUnit) ?? assetUnit;
		}
	}

	private decodeAssetName(assetUnit: string): string | null {
		if (assetUnit.length <= 56) {
			return null;
		}

		const assetNameHex = assetUnit.slice(56);
		if (assetNameHex.length === 0 || assetNameHex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(assetNameHex)) {
			return null;
		}

		try {
			const decoded = Buffer.from(assetNameHex, 'hex').toString('utf8').replace(/\0/g, '').trim();
			if (decoded.length === 0) {
				return null;
			}

			return /^[\x20-\x7E]+$/.test(decoded) ? decoded : null;
		} catch {
			return null;
		}
	}

	private formatSixDecimalAmount(rawAmount: string): string {
		const amount = BigInt(rawAmount);
		const whole = amount / WebhookSenderService.LOVELACE_DECIMALS;
		const fraction = (amount % WebhookSenderService.LOVELACE_DECIMALS).toString().padStart(6, '0').replace(/0+$/, '');

		return fraction.length > 0 ? `${whole}.${fraction}` : whole.toString();
	}

	/**
	 * Update webhook endpoint failure tracking
	 */
	private async updateWebhookFailureTracking(webhookEndpointId: string): Promise<void> {
		const webhook = await prisma.webhookEndpoint.findUnique({
			where: { id: webhookEndpointId },
		});

		if (!webhook) return;

		const consecutiveFailures = webhook.consecutiveFailures + 1;
		const shouldDisable = consecutiveFailures >= 10;

		await prisma.webhookEndpoint.update({
			where: { id: webhookEndpointId },
			data: {
				failureCount: { increment: 1 },
				consecutiveFailures,
				disabledAt: shouldDisable ? new Date() : undefined,
				isActive: shouldDisable ? false : undefined,
			},
		});

		if (shouldDisable) {
			logger.warn('Webhook endpoint disabled due to consecutive failures', {
				webhook_id: webhookEndpointId,
				consecutive_failures: consecutiveFailures,
			});
		}
	}
}

export const webhookSenderService = new WebhookSenderService();
