import { WebhookDeliveryStatus, WebhookEventType } from '@prisma/client';
import { prisma } from '@/utils/db';
import { logger } from '@/utils/logger';
import { webhookSenderService } from './webhook-sender.service';

export class WebhookQueueService {
  async queueWebhook(
    eventType: WebhookEventType,
    payload: Record<string, any>,
    entityId?: string,
    paymentSourceId?: string,
  ): Promise<void> {
    const webhookEndpoints = await prisma.webhookEndpoint.findMany({
      where: {
        isActive: true,
        disabledAt: null,
        events: {
          has: eventType,
        },
        ...(paymentSourceId
          ? {
              OR: [
                { paymentSourceId: paymentSourceId },
                { paymentSourceId: null },
              ],
            }
          : {}),
      },
      orderBy: [{ lastSuccessAt: 'asc' }, { updatedAt: 'asc' }],
      take: 50,
    });

    if (webhookEndpoints.length === 0) {
      logger.debug('No active webhook endpoints found for event', {
        event_type: eventType,
        payment_source_id: paymentSourceId,
        entity_id: entityId,
      });
      return;
    }

    const webhookPayload = {
      event_type: eventType,
      timestamp: new Date().toISOString(),
      webhook_id: '',
      data: payload,
    };

    const deliveries = webhookEndpoints.map(async (endpoint) => {
      const endpointPayload = {
        ...webhookPayload,
        webhook_id: endpoint.id,
      };

      try {
        await prisma.webhookDelivery.create({
          data: {
            webhookEndpointId: endpoint.id,
            eventType,
            payload: endpointPayload as Record<string, any>,
            entityId,
            status: WebhookDeliveryStatus.Pending,
            nextRetryAt: new Date(),
          },
        });

        logger.info('Webhook queued for delivery', {
          webhook_id: endpoint.id,
          event_type: eventType,
          entity_id: entityId,
        });
      } catch (error) {
        logger.error('Failed to queue webhook delivery', {
          webhook_id: endpoint.id,
          event_type: eventType,
          entity_id: entityId,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    await Promise.allSettled(deliveries);
  }

  /**
   * Process pending webhook deliveries
   */
  async processPendingDeliveries(): Promise<void> {
    const pendingDeliveries = await prisma.webhookDelivery.findMany({
      where: {
        status: {
          in: [WebhookDeliveryStatus.Pending, WebhookDeliveryStatus.Retrying],
        },
        nextRetryAt: {
          lte: new Date(),
        },
        WebhookEndpoint: {
          isActive: true,
        },
      },
      include: {
        WebhookEndpoint: true,
      },
      orderBy: [{ updatedAt: 'asc' }, { createdAt: 'asc' }],
      take: 50,
    });

    if (pendingDeliveries.length === 0) {
      logger.debug('No pending webhook deliveries to process');
      return;
    }

    logger.info('Processing pending webhook deliveries', {
      count: pendingDeliveries.length,
    });

    const batchSize = 10;
    for (let i = 0; i < pendingDeliveries.length; i += batchSize) {
      const batch = pendingDeliveries.slice(i, i + batchSize);

      const promises = batch.map(async (delivery) => {
        try {
          await webhookSenderService.processWebhookDelivery(delivery.id);
        } catch (error) {
          logger.error('Error processing webhook delivery', {
            delivery_id: delivery.id,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      });

      await Promise.allSettled(promises);
    }
  }

  /**
   * Clean up old webhook deliveries
   */
  async cleanupOldDeliveries(): Promise<void> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 30); // Delete deliveries older than 30 days

    try {
      const result = await prisma.webhookDelivery.deleteMany({
        where: {
          createdAt: {
            lt: cutoffDate,
          },
          status: {
            in: [
              WebhookDeliveryStatus.Success,
              WebhookDeliveryStatus.Failed,
              WebhookDeliveryStatus.Cancelled,
            ],
          },
        },
      });

      if (result.count > 0) {
        logger.info('Cleaned up old webhook deliveries', {
          deleted_count: result.count,
          cutoff_date: cutoffDate.toISOString(),
        });
      }
    } catch (error) {
      logger.error('Failed to clean up old webhook deliveries', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Get delivery statistics for monitoring
   */
  async getDeliveryStats(): Promise<{
    pending: number;
    success: number;
    failed: number;
    retrying: number;
  }> {
    const [pending, success, failed, retrying] = await Promise.all([
      prisma.webhookDelivery.count({
        where: { status: WebhookDeliveryStatus.Pending },
      }),
      prisma.webhookDelivery.count({
        where: { status: WebhookDeliveryStatus.Success },
      }),
      prisma.webhookDelivery.count({
        where: { status: WebhookDeliveryStatus.Failed },
      }),
      prisma.webhookDelivery.count({
        where: { status: WebhookDeliveryStatus.Retrying },
      }),
    ]);

    return { pending, success, failed, retrying };
  }
}

export const webhookQueueService = new WebhookQueueService();
