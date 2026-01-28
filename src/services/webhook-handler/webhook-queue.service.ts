import {
  WebhookDeliveryStatus,
  WebhookEventType,
} from '@/generated/prisma/client';
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
    const webhookPayload = {
      event_type: eventType,
      timestamp: new Date().toISOString(),
      webhook_id: '',
      data: payload,
    };

    const batchSize = 20;
    let hasMore = true;
    let cursorId: string | undefined = undefined;
    let totalQueued = 0;

    while (hasMore) {
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
        orderBy: { id: 'asc' },
        take: batchSize,
        cursor: cursorId ? { id: cursorId } : undefined,
      });

      if (webhookEndpoints.length != 0) {
        const lastEndpoint: { id: string } =
          webhookEndpoints[webhookEndpoints.length - 1];
        cursorId = lastEndpoint.id;
        totalQueued += webhookEndpoints.length;
      }

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
              status: WebhookDeliveryStatus.Pending as WebhookDeliveryStatus,
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

      if (webhookEndpoints.length < batchSize) {
        hasMore = false;
      }
    }

    if (totalQueued === 0) {
      logger.debug('No active webhook endpoints found for event', {
        event_type: eventType,
        payment_source_id: paymentSourceId,
        entity_id: entityId,
      });
    } else {
      logger.info('Finished queuing webhooks', {
        event_type: eventType,
        total_queued: totalQueued,
        entity_id: entityId,
      });
    }
  }

  /**
   * Process pending webhook deliveries
   */
  async processPendingDeliveries(): Promise<void> {
    const pendingDeliveries = await prisma.webhookDelivery.findMany({
      where: {
        status: {
          in: [
            WebhookDeliveryStatus.Pending as WebhookDeliveryStatus,
            WebhookDeliveryStatus.Retrying as WebhookDeliveryStatus,
          ],
        },
        nextRetryAt: {
          lte: new Date(),
        },
        WebhookEndpoint: {
          isActive: true,
        },
      },
      select: {
        id: true,
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
              WebhookDeliveryStatus.Success as WebhookDeliveryStatus,
              WebhookDeliveryStatus.Failed as WebhookDeliveryStatus,
              WebhookDeliveryStatus.Cancelled as WebhookDeliveryStatus,
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
}

export const webhookQueueService = new WebhookQueueService();
