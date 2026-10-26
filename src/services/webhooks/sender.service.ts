import { WebhookDeliveryStatus, WebhookEventType, WebhookFormat } from '@/generated/prisma/client';
import { WEBHOOK_TEST_EVENT_TYPE } from '@/types/webhook-constants';
import type { StoredWebhookPayload, WebhookSendPayload, WebhookTestPayload } from '@/types/webhook-payloads';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { getOwnPlainObject, getOwnString, isPlainObject } from '@masumi/payment-core/object-properties';
import { buildCompactSummary } from './compact-summary';
import { findHydraHeadPaymentSourceId, isSourceScopedHydraEvent } from './hydra-source';
import { decryptWebhookAuthTokenSafe, decryptWebhookUrlForDelivery } from '@/utils/security/webhook-secrets';
import {
	isWebhookDestinationPolicyError,
	redactWebhookDestination,
	resolveWebhookDestinationAllowed,
	WEBHOOK_DELIVERY_BLOCKED_MESSAGE,
} from '@/utils/security/webhook-destination-policy';
import { postPinnedWebhook } from './pinned-request';

interface WebhookDeliveryResult {
	success: boolean;
	responseCode?: number;
	errorMessage?: string;
	durationMs: number;
}

const resolveDestinationWithSignal = async (url: string, signal: AbortSignal) => {
	signal.throwIfAborted();
	let abort: () => void = () => undefined;
	try {
		return await new Promise<Awaited<ReturnType<typeof resolveWebhookDestinationAllowed>>>((resolve, reject) => {
			abort = () => reject(signal.reason instanceof Error ? signal.reason : new Error('Webhook request aborted'));
			signal.addEventListener('abort', abort, { once: true });
			void resolveWebhookDestinationAllowed(url).then(resolve, reject);
		});
	} finally {
		signal.removeEventListener('abort', abort);
	}
};

/**
 * Service for sending individual webhook HTTP requests
 */
class WebhookSenderService {
	private static readonly REQUEST_TIMEOUT = 10000;
	private static readonly USER_AGENT = 'Masumi-Webhook/1.0';
	private static readonly EVENT_TYPES = new Set<string>(Object.values(WebhookEventType));
	private static readonly NETWORK_ERROR_CODES = new Set([
		'ECONNREFUSED',
		'ECONNRESET',
		'EHOSTUNREACH',
		'ENETUNREACH',
		'ETIMEDOUT',
		'EPIPE',
		'ERR_TLS_CERT_ALTNAME_INVALID',
	]);

	/**
	 * Send a webhook to a specific URL
	 */
	async sendWebhook(
		url: string,
		format: WebhookFormat,
		authToken: string | null,
		payload: WebhookSendPayload,
	): Promise<WebhookDeliveryResult> {
		const redactedUrl = redactWebhookDestination(url);
		const startTime = Date.now();
		const signal = AbortSignal.timeout(WebhookSenderService.REQUEST_TIMEOUT);

		try {
			const destination = await resolveDestinationWithSignal(url, signal);
			logger.info('Sending webhook', {
				url: redactedUrl,
				format,
				event_type: payload.event_type,
			});

			const request = this.buildRequest(format, authToken, payload);
			const response = await postPinnedWebhook(destination, request, signal);

			const durationMs = Date.now() - startTime;

			if (response.ok) {
				logger.info('Webhook delivered successfully', {
					url: redactedUrl,
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
					url: redactedUrl,
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
			if (isWebhookDestinationPolicyError(error)) {
				logger.warn('Webhook delivery blocked by policy', {
					url: redactedUrl,
					format,
					event_type: payload.event_type,
					reason: error.reason,
				});

				return {
					success: false,
					errorMessage: WEBHOOK_DELIVERY_BLOCKED_MESSAGE,
					durationMs: 0,
				};
			}

			const durationMs = Date.now() - startTime;
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';

			// Check if this is a timeout or HTTP connection error
			const isTimeoutError = this.isTimeoutOrNetworkError(error);

			if (isTimeoutError) {
				// Log timeout/network errors as warnings (expected external issues)
				logger.warn('Webhook delivery timeout/network error', {
					url: redactedUrl,
					format,
					event_type: payload.event_type,
					error: errorMessage,
					duration_ms: durationMs,
				});
			} else {
				// Log other errors as errors (unexpected application issues)
				logger.error('Webhook delivery error', {
					url: redactedUrl,
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

		// Recheck older queued scoped Hydra rows before sending. They may have been
		// persisted before source-scoped selection was enforced at enqueue time.
		if (
			(isSourceScopedHydraEvent(delivery.eventType) || isSourceScopedHydraEvent(delivery.payload.event_type)) &&
			delivery.WebhookEndpoint.paymentSourceId !== null
		) {
			const isLowBalance = delivery.eventType === WebhookEventType.HYDRA_HEAD_LOW_BALANCE;
			const hydraHeadId = getOwnString(delivery.payload.data, 'hydraHeadId');
			const hydraLocalParticipantId = isLowBalance
				? getOwnString(delivery.payload.data, 'hydraLocalParticipantId')
				: undefined;
			let paymentSourceId: string | null = null;
			if (
				delivery.eventType === delivery.payload.event_type &&
				hydraHeadId &&
				(!isLowBalance || hydraLocalParticipantId)
			) {
				try {
					paymentSourceId = await findHydraHeadPaymentSourceId(hydraHeadId, prisma, hydraLocalParticipantId);
				} catch (error) {
					const isFinalAttempt = updatedDelivery.attempts >= delivery.maxAttempts;
					await prisma.webhookDelivery.update({
						where: { id: deliveryId },
						data: {
							status: isFinalAttempt ? WebhookDeliveryStatus.Failed : WebhookDeliveryStatus.Retrying,
							errorMessage: 'Could not verify Hydra webhook source',
							nextRetryAt: isFinalAttempt
								? null
								: new Date(Date.now() + this.calculateRetryDelay(updatedDelivery.attempts)),
						},
					});
					logger.error('Hydra webhook source lookup failed', {
						delivery_id: deliveryId,
						error: error instanceof Error ? error.message : 'Unknown error',
					});
					return;
				}
			}
			if (paymentSourceId === null || delivery.WebhookEndpoint.paymentSourceId !== paymentSourceId) {
				await prisma.webhookDelivery.update({
					where: { id: deliveryId },
					data: {
						status: WebhookDeliveryStatus.Cancelled,
						errorMessage: 'Hydra webhook source does not match its endpoint',
					},
				});
				logger.warn('Cancelled Hydra webhook delivery with unverified source', { delivery_id: deliveryId });
				return;
			}
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

		// Check for timeout errors (from AbortSignal.timeout)
		if (errorName === 'aborterror' || errorName === 'timeouterror') {
			return true;
		}

		const code = (error as NodeJS.ErrnoException).code;
		return typeof code === 'string' && WebhookSenderService.NETWORK_ERROR_CODES.has(code);
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
						text: buildCompactSummary(payload),
					}),
				};
			case WebhookFormat.GOOGLE_CHAT:
				return {
					headers: {
						'Content-Type': 'application/json; charset=UTF-8',
						'User-Agent': WebhookSenderService.USER_AGENT,
					},
					body: JSON.stringify({
						text: buildCompactSummary(payload),
					}),
				};
			case WebhookFormat.DISCORD:
				return {
					headers: {
						'Content-Type': 'application/json',
						'User-Agent': WebhookSenderService.USER_AGENT,
					},
					body: JSON.stringify({
						content: buildCompactSummary(payload),
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
