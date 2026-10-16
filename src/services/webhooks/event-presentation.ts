/** The emoji and title a webhook message leads with, per event type. */
import { WebhookEventType } from '@/generated/prisma/client';
import { WEBHOOK_TEST_EVENT_TYPE } from '@/types/webhook-constants';
import type { WebhookSendPayload } from '@/types/webhook-payloads';

export function getWebhookEventPresentation(eventType: WebhookSendPayload['event_type']): {
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
		case WebhookEventType.FUND_DISTRIBUTION_CONFIRMED:
			return { emoji: '✅', title: 'Fund distribution confirmed' };
		case WebhookEventType.FUND_DISTRIBUTION_FAILED:
			return { emoji: '🚨', title: 'Fund distribution failed' };
		case WebhookEventType.X402_PAYMENT_SETTLED:
			return { emoji: '✅', title: 'x402 payment settled' };
		case WebhookEventType.X402_PAYMENT_FAILED:
			return { emoji: '🚨', title: 'x402 payment failed' };
		case WebhookEventType.X402_WALLET_LOW_BALANCE:
			return { emoji: '🪫', title: 'x402 wallet balance low' };
		case WebhookEventType.HYDRA_HEAD_LOW_BALANCE:
			return { emoji: '🪫', title: 'Hydra in-head balance low' };
		case WebhookEventType.HYDRA_HEAD_SNAPSHOT_ROUND_STUCK:
			return { emoji: '🧊', title: 'Hydra snapshot round stuck' };
		case WEBHOOK_TEST_EVENT_TYPE:
			return { emoji: '🧪', title: 'Test webhook delivery' };
		default:
			return { emoji: '🔔', title: eventType };
	}
}
