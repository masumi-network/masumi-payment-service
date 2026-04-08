import type { Client } from '@/lib/api/generated/client';
import type { WebhookEvent, WebhookFormat } from '@/lib/webhooks';

type PatchWebhookRequestBody = {
  webhookId: string;
  url: string;
  format: WebhookFormat;
  Events: WebhookEvent[];
  name?: string;
  authToken?: string;
};

type PatchWebhookResponse = {
  status: string;
  data: {
    id: string;
    url: string;
    format: WebhookFormat;
    Events: WebhookEvent[];
    name: string | null;
    isActive: boolean;
    createdAt: string;
    updatedAt: string;
    paymentSourceId: string | null;
  };
};

type TestWebhookRequestBody = {
  webhookId: string;
};

type TestWebhookResponse = {
  status: string;
  data: {
    webhookId: string;
    success: boolean;
    responseCode: number | null;
    errorMessage: string | null;
    durationMs: number;
  };
};

export function patchWebhook(client: Client, body: PatchWebhookRequestBody) {
  return client.patch<PatchWebhookResponse, unknown>({
    url: '/webhooks',
    body,
    headers: {
      'Content-Type': 'application/json',
    },
    responseType: 'json',
  });
}

export function testWebhook(client: Client, body: TestWebhookRequestBody) {
  return client.post<TestWebhookResponse, unknown>({
    url: '/webhooks/test',
    body,
    headers: {
      'Content-Type': 'application/json',
    },
    responseType: 'json',
  });
}
