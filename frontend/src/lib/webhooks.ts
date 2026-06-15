import type { GetWebhooksResponses } from '@/lib/api/generated';

export const WEBHOOK_FORMATS = ['EXTENDED', 'SLACK', 'GOOGLE_CHAT', 'DISCORD'] as const;
export const WEBHOOK_EVENTS = [
  'PURCHASE_ON_CHAIN_STATUS_CHANGED',
  'PAYMENT_ON_CHAIN_STATUS_CHANGED',
  'PURCHASE_ON_ERROR',
  'PAYMENT_ON_ERROR',
  'WALLET_LOW_BALANCE',
  'FUND_DISTRIBUTION_SENT',
  'X402_PAYMENT_SETTLED',
  'X402_PAYMENT_FAILED',
  'X402_WALLET_LOW_BALANCE',
] as const;

export type WebhookFormat = (typeof WEBHOOK_FORMATS)[number];
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
export type WebhookRecord = GetWebhooksResponses[200]['data']['Webhooks'][number];

// Events split by the rail they belong to. x402 events are emitted by the EVM rail; the
// rest are Cardano escrow/payment events. The webhooks UI scopes its event options — and
// the visible webhook list — to the active rail so each rail shows only its own events.
export const X402_WEBHOOK_EVENTS = [
  'X402_PAYMENT_SETTLED',
  'X402_PAYMENT_FAILED',
  'X402_WALLET_LOW_BALANCE',
] as const satisfies readonly WebhookEvent[];

export const CARDANO_WEBHOOK_EVENTS = WEBHOOK_EVENTS.filter(
  (event): event is WebhookEvent => !(X402_WEBHOOK_EVENTS as readonly string[]).includes(event),
);

export function isX402WebhookEvent(event: WebhookEvent): boolean {
  return (X402_WEBHOOK_EVENTS as readonly string[]).includes(event);
}

/** Webhook events relevant to a given rail. */
export function webhookEventsForRail(rail: 'cardano' | 'x402'): WebhookEvent[] {
  return rail === 'x402' ? [...X402_WEBHOOK_EVENTS] : [...CARDANO_WEBHOOK_EVENTS];
}

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
  X402_PAYMENT_SETTLED: 'x402 payment settled',
  X402_PAYMENT_FAILED: 'x402 payment failed',
  X402_WALLET_LOW_BALANCE: 'x402 wallet low balance',
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
