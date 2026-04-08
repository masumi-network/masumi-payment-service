import { WebhookDeliveryStatus, WebhookEventType, WebhookFormat } from '@/generated/prisma/client';
import { WEBHOOK_TEST_EVENT_TYPE } from '@/types/webhook-constants';
import type { StoredWebhookPayload, WebhookSendPayload, WebhookTestPayload } from '@/types/webhook-payloads';
import { prisma } from '@/utils/db';
import { logger } from '@/utils/logger';
import { getOwnPlainObject, getOwnString, isPlainObject } from '@/utils/object-properties';

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

		const result = await this.sendWebhook(webhook.url, webhook.format, webhook.authToken, payload);

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

		const result = await this.sendWebhook(
			delivery.WebhookEndpoint.url,
			delivery.WebhookEndpoint.format,
			delivery.WebhookEndpoint.authToken,
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
		const serviceName = getOwnString(value, 'service_name');
		const timestamp = getOwnString(value, 'timestamp');
		const webhookId = getOwnString(value, 'webhook_id');
		const data = getOwnPlainObject(value, 'data');

		return (
			eventType !== undefined &&
			WebhookSenderService.EVENT_TYPES.has(eventType) &&
			serviceName !== undefined &&
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
		const lines = [`[${payload.service_name}] ${payload.event_type}`];

		if (payload.event_type === WEBHOOK_TEST_EVENT_TYPE) {
			this.appendLine(lines, 'message', payload.data.message);
			this.appendLine(lines, 'webhookName', payload.data.webhookName);
			this.appendLine(lines, 'webhookFormat', payload.data.webhookFormat);
			this.appendLine(lines, 'paymentSourceId', payload.data.paymentSourceId);
			this.appendLine(lines, 'triggeredByApiKeyId', payload.data.triggeredByApiKeyId);
			this.appendLine(lines, 'timestamp', payload.timestamp);
			return lines.join('\n');
		}

		if (payload.event_type === WebhookEventType.WALLET_LOW_BALANCE) {
			this.appendLine(lines, 'walletId', payload.data.walletId);
			this.appendLine(lines, 'walletAddress', payload.data.walletAddress);
			this.appendLine(lines, 'paymentSourceId', payload.data.paymentSourceId);
			this.appendLine(lines, 'network', payload.data.network);
			this.appendLine(lines, 'assetUnit', payload.data.assetUnit);
			this.appendLine(lines, 'currentAmount', payload.data.currentAmount);
			this.appendLine(lines, 'thresholdAmount', payload.data.thresholdAmount);
			this.appendLine(lines, 'checkedAt', payload.data.checkedAt);
			this.appendLine(lines, 'timestamp', payload.timestamp);
			return lines.join('\n');
		}

		this.appendLine(lines, 'id', payload.data.id);
		this.appendLine(lines, 'blockchainIdentifier', payload.data.blockchainIdentifier);
		this.appendLine(lines, 'paymentSourceId', payload.data.PaymentSource.id);
		this.appendLine(lines, 'network', payload.data.PaymentSource.network);
		this.appendLine(lines, 'onChainState', payload.data.onChainState);
		this.appendLine(lines, 'nextAction', payload.data.NextAction.requestedAction);
		this.appendLine(lines, 'errorType', payload.data.NextAction.errorType);
		this.appendLine(lines, 'errorNote', payload.data.NextAction.errorNote);
		this.appendLine(lines, 'timestamp', payload.timestamp);

		return lines.join('\n');
	}

	private appendLine(lines: string[], key: string, value: string | null | undefined): void {
		if (value == null || value === '') {
			return;
		}

		lines.push(`${key}: ${value}`);
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
