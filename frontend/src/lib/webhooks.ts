import type { GetWebhooksResponses } from '@/lib/api/generated';

export const WEBHOOK_FORMATS = ['EXTENDED', 'SLACK', 'GOOGLE_CHAT', 'DISCORD'] as const;
export const WEBHOOK_EVENTS = [
  'PURCHASE_ON_CHAIN_STATUS_CHANGED',
  'PAYMENT_ON_CHAIN_STATUS_CHANGED',
  'PURCHASE_ON_ERROR',
  'PAYMENT_ON_ERROR',
  'WALLET_LOW_BALANCE',
  'FUND_DISTRIBUTION_SENT',
] as const;

export type WebhookFormat = (typeof WEBHOOK_FORMATS)[number];
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
export type WebhookRecord = GetWebhooksResponses[200]['data']['Webhooks'][number];

export const WEBHOOK_FORMAT_LABELS: Record<WebhookFormat, string> = {
  EXTENDED: 'Extended',
  SLACK: 'Slack',
  GOOGLE_CHAT: 'Google Chat',
  DISCORD: 'Discord',
};

export const WEBHOOK_EVENT_LABELS: Record<WebhookEvent, string> = {
  PURCHASE_ON_CHAIN_STATUS_CHANGED: 'Purchase status changed',
  PAYMENT_ON_CHAIN_STATUS_CHANGED: 'Payment status changed',
  PURCHASE_ON_ERROR: 'Purchase error',
  PAYMENT_ON_ERROR: 'Payment error',
  WALLET_LOW_BALANCE: 'Wallet low balance',
  FUND_DISTRIBUTION_SENT: 'Fund distribution sent',
};

export function formatWebhookDate(value: Date | string | null | undefined) {
  if (!value) return 'Never';

  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return 'Never';
  }

  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

export function getWebhookStatus(webhook: Pick<WebhookRecord, 'isActive' | 'disabledAt'>) {
  return webhook.disabledAt || !webhook.isActive ? 'Disabled' : 'Active';
}
