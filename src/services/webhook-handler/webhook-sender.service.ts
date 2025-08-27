import { WebhookDeliveryStatus } from '@prisma/client';
import { prisma } from '@/utils/db';
import { logger } from '@/utils/logger';
import { WebhookPayload } from '@/types/webhook-payloads';

export interface WebhookDeliveryResult {
  success: boolean;
  responseCode?: number;
  errorMessage?: string;
  durationMs: number;
}

/**
 * Service for sending individual webhook HTTP requests
 */
export class WebhookSenderService {
  private static readonly REQUEST_TIMEOUT = 10000;
  private static readonly USER_AGENT = 'Masumi-Webhook/1.0';

  /**
   * Send a webhook to a specific URL
   */
  async sendWebhook(
    url: string,
    authToken: string,
    payload: WebhookPayload,
  ): Promise<WebhookDeliveryResult> {
    const startTime = Date.now();

    try {
      logger.info('Sending webhook', {
        url,
        event_type: payload.event_type,
      });

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
          'X-Masumi-Event': payload.event_type,
          'X-Masumi-Timestamp': payload.timestamp,
          'User-Agent': WebhookSenderService.USER_AGENT,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(WebhookSenderService.REQUEST_TIMEOUT),
      });

      const durationMs = Date.now() - startTime;

      if (response.ok) {
        logger.info('Webhook delivered successfully', {
          url,
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
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';

      // Check if this is a timeout or HTTP connection error
      const isTimeoutError = this.isTimeoutOrNetworkError(error);

      if (isTimeoutError) {
        // Log timeout/network errors as warnings (expected external issues)
        logger.warn('Webhook delivery timeout/network error', {
          url,
          event_type: payload.event_type,
          error: errorMessage,
          duration_ms: durationMs,
        });
      } else {
        // Log other errors as errors (unexpected application issues)
        logger.error('Webhook delivery error', {
          url,
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
        data: { status: WebhookDeliveryStatus.Cancelled },
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
        data: { status: WebhookDeliveryStatus.Failed },
      });

      // Update webhook endpoint failure tracking
      await this.updateWebhookFailureTracking(delivery.webhookEndpointId);
      return;
    }

    await prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: WebhookDeliveryStatus.Retrying,
        attempts: { increment: 1 },
      },
    });

    const result = await this.sendWebhook(
      delivery.WebhookEndpoint.url,
      delivery.WebhookEndpoint.authToken,
      delivery.payload as unknown as WebhookPayload,
    );

    if (result.success) {
      await prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: {
          status: WebhookDeliveryStatus.Success,
          responseCode: result.responseCode,
          deliveredAt: new Date(),
          durationMs: result.durationMs,
        },
      });

      // Update webhook endpoint success tracking
      await this.updateWebhookSuccessTracking(delivery.webhookEndpointId);
    } else {
      const nextRetryDelay = this.calculateRetryDelay(delivery.attempts);
      const nextRetryAt = new Date(Date.now() + nextRetryDelay);

      const isFinalAttempt = delivery.attempts >= delivery.maxAttempts;

      await prisma.webhookDelivery.update({
        where: { id: deliveryId },
        data: {
          status: isFinalAttempt
            ? WebhookDeliveryStatus.Failed
            : WebhookDeliveryStatus.Pending,
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

    const delay = Math.min(
      baseDelay * Math.pow(2, attemptNumber - 1),
      maxDelay,
    );

    const jitter = Math.random() * 0.3 * delay;

    return Math.floor(delay + jitter);
  }

  /**
   * Update webhook endpoint success tracking
   */
  private async updateWebhookSuccessTracking(
    webhookEndpointId: string,
  ): Promise<void> {
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

  /**
   * Update webhook endpoint failure tracking
   */
  private async updateWebhookFailureTracking(
    webhookEndpointId: string,
  ): Promise<void> {
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
