import { useEffect, useMemo, useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { toast } from 'react-toastify';
import { deleteWebhooks, postWebhooksTest } from '@/lib/api/generated';
import { MainLayout } from '@/components/layout/MainLayout';
import { AnimatedPage } from '@/components/ui/animated-page';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { RefreshButton } from '@/components/RefreshButton';
import { SearchInput } from '@/components/ui/search-input';
import { Tabs } from '@/components/ui/tabs';
import { WebhookDialog } from '@/components/webhooks/WebhookDialog';
import { useAppContext } from '@/lib/contexts/AppContext';
import { useWebhooks } from '@/lib/hooks/useWebhooks';
import { shortenAddress } from '@/lib/utils';
import { useApiMutation } from '@/lib/hooks/useApiMutation';
import {
  WEBHOOK_EVENT_LABELS,
  WEBHOOK_FORMAT_LABELS,
  formatWebhookDate,
  getWebhookStatus,
  webhookEventsForRail,
  type WebhookEvent,
  type WebhookRecord,
} from '@/lib/webhooks';

const formatTabs = [
  { name: 'All' },
  { name: 'Extended' },
  { name: 'Slack' },
  { name: 'Google Chat' },
  { name: 'Discord' },
] as const;

const formatTabToValue = {
  All: null,
  Extended: 'EXTENDED',
  Slack: 'SLACK',
  'Google Chat': 'GOOGLE_CHAT',
  Discord: 'DISCORD',
} as const;

const allEventsFilterValue = 'ALL_EVENTS';

export default function WebhooksPage() {
  const router = useRouter();
  const { apiClient, selectedPaymentSource, selectedPaymentSourceId, activeRail } = useAppContext();
  // Scope webhook events to the active rail: x402 events on the EVM rail, Cardano escrow
  // events on the Cardano rail. The event filter, the visible list, and the create/edit
  // dialog all use this so each rail shows only its own events.
  const railEvents = useMemo(() => webhookEventsForRail(activeRail), [activeRail]);
  const { webhooks, isLoading, isFetching, refetch, reset } = useWebhooks();
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFormatTab, setActiveFormatTab] =
    useState<(typeof formatTabs)[number]['name']>('All');
  const [activeEventFilter, setActiveEventFilter] = useState<
    typeof allEventsFilterValue | WebhookEvent
  >(allEventsFilterValue);
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [webhookToEdit, setWebhookToEdit] = useState<WebhookRecord | null>(null);
  const [webhookToDelete, setWebhookToDelete] = useState<WebhookRecord | null>(null);
  const deleteWebhookMutation = useApiMutation({
    mutationFn: (body: { webhookId: string }) => deleteWebhooks({ client: apiClient, body }),
    errorMessage: 'Failed to delete webhook',
  });
  const isDeleting = deleteWebhookMutation.isPending;
  const testWebhookMutation = useApiMutation({
    mutationFn: (body: { webhookId: string }) => postWebhooksTest({ client: apiClient, body }),
    errorMessage: 'Failed to send test webhook',
  });
  const [testingWebhookId, setTestingWebhookId] = useState<string | null>(null);

  useEffect(() => {
    if (router.query.action === 'add_webhook' && selectedPaymentSourceId) {
      queueMicrotask(() => setIsAddDialogOpen(true));
      router.replace('/webhooks', undefined, { shallow: true });
    }
  }, [router, router.query.action, selectedPaymentSourceId]);

  const tabs = useMemo(
    () =>
      formatTabs.map((tab) => {
        const format = formatTabToValue[tab.name];

        return {
          name: tab.name,
          count: format
            ? webhooks.filter((webhook) => webhook.format === format).length
            : webhooks.length,
        };
      }),
    [webhooks],
  );

  const eventFilterOptions = useMemo(
    () => [
      { value: allEventsFilterValue, label: 'All events' },
      ...railEvents.map((event) => ({
        value: event,
        label: WEBHOOK_EVENT_LABELS[event],
      })),
    ],
    [railEvents],
  );

  // A specific event filter chosen on one rail isn't valid on the other. Rather than reset
  // it in an effect, derive the effective filter: fall back to "All events" whenever the
  // selected event isn't part of the active rail's events. (Create/edit dialogs are modal,
  // so the rail/source can't change underneath an open one — no dialog-close effect needed.)
  const effectiveEventFilter =
    activeEventFilter !== allEventsFilterValue && railEvents.includes(activeEventFilter)
      ? activeEventFilter
      : allEventsFilterValue;

  const filteredWebhooks = useMemo(() => {
    const selectedFormat = formatTabToValue[activeFormatTab];
    const query = searchQuery.trim().toLowerCase();

    return webhooks.filter((webhook) => {
      // Only show webhooks that subscribe to at least one event for the active rail, so the
      // Cardano rail lists Cardano webhooks and the x402 rail lists x402 webhooks.
      if (!webhook.Events.some((event) => railEvents.includes(event))) {
        return false;
      }

      if (selectedFormat && webhook.format !== selectedFormat) {
        return false;
      }

      if (
        effectiveEventFilter !== allEventsFilterValue &&
        !webhook.Events.includes(effectiveEventFilter)
      ) {
        return false;
      }

      if (!query) {
        return true;
      }

      const searchableValues = [
        webhook.name ?? '',
        webhook.url,
        WEBHOOK_FORMAT_LABELS[webhook.format],
        ...webhook.Events.map((event) => WEBHOOK_EVENT_LABELS[event]),
      ];

      return searchableValues.some((value) => value.toLowerCase().includes(query));
    });
  }, [effectiveEventFilter, activeFormatTab, searchQuery, webhooks, railEvents]);

  const hasActiveFilters =
    searchQuery.trim().length > 0 ||
    activeFormatTab !== 'All' ||
    effectiveEventFilter !== allEventsFilterValue;

  const handleDeleteWebhook = async () => {
    if (!webhookToDelete) return;

    const response = await deleteWebhookMutation
      .mutateAsync({ webhookId: webhookToDelete.id })
      .catch((error: unknown) => {
        console.error('Failed to delete webhook:', error);
        return null;
      });
    setWebhookToDelete(null);
    if (response) {
      toast.success('Webhook deleted successfully');
      void reset();
    }
  };

  const handleSendTestWebhook = async (webhook: WebhookRecord) => {
    setTestingWebhookId(webhook.id);

    const response = await testWebhookMutation
      .mutateAsync({ webhookId: webhook.id })
      .catch((error: unknown) => {
        console.error('Failed to send test webhook:', error);
        return null;
      });
    setTestingWebhookId(null);
    if (response) {
      handleTestResult(response);
    }
  };

  const handleTestResult = (response: Awaited<ReturnType<typeof postWebhooksTest>>) => {
    const result = (
      response as {
        data?: {
          data?: {
            webhookId: string;
            success: boolean;
            responseCode: number | null;
            errorMessage: string | null;
            durationMs: number;
          };
        };
      }
    ).data?.data;

    if (!result) {
      toast.error('Missing test delivery result');
      return;
    }

    if (result.success) {
      toast.success('Test webhook delivered successfully');
      void refetch();
      return;
    }

    toast.error(result.errorMessage || 'Delivery failed');
  };

  const renderTable = () => {
    if (isLoading && webhooks.length === 0) {
      return (
        <div className="rounded-lg border p-8">
          <div className="space-y-3 animate-pulse">
            <div className="h-4 w-40 rounded bg-muted" />
            <div className="h-12 rounded bg-muted/70" />
            <div className="h-12 rounded bg-muted/70" />
            <div className="h-12 rounded bg-muted/70" />
          </div>
        </div>
      );
    }

    if (filteredWebhooks.length === 0) {
      return (
        <div className="rounded-lg border">
          <EmptyState
            icon={hasActiveFilters ? 'search' : 'inbox'}
            title={hasActiveFilters ? 'No webhooks match these filters' : 'No webhooks yet'}
            description={
              hasActiveFilters
                ? 'Try another format, event filter, or search term.'
                : 'Create your first webhook for this payment source to send alerts into your preferred chat tool.'
            }
            action={
              !hasActiveFilters ? (
                <Button onClick={() => setIsAddDialogOpen(true)}>
                  <Plus className="h-4 w-4" />
                  Add webhook
                </Button>
              ) : undefined
            }
          />
        </div>
      );
    }

    return (
      <div className="rounded-lg border overflow-x-auto">
        <table className="w-full min-w-[1080px]">
          <thead className="bg-muted/30 dark:bg-muted/15">
            <tr className="border-b">
              <th
                scope="col"
                className="p-4 pl-6 text-left text-sm font-medium text-muted-foreground"
              >
                Name
              </th>
              <th scope="col" className="p-4 text-left text-sm font-medium text-muted-foreground">
                Format
              </th>
              <th scope="col" className="p-4 text-left text-sm font-medium text-muted-foreground">
                Events
              </th>
              <th scope="col" className="p-4 text-left text-sm font-medium text-muted-foreground">
                URL
              </th>
              <th scope="col" className="p-4 text-left text-sm font-medium text-muted-foreground">
                Status
              </th>
              <th scope="col" className="p-4 text-left text-sm font-medium text-muted-foreground">
                Last success
              </th>
              <th scope="col" className="p-4 text-left text-sm font-medium text-muted-foreground">
                Failures
              </th>
              <th scope="col" className="p-4 text-left text-sm font-medium text-muted-foreground">
                Updated
              </th>
              <th
                scope="col"
                className="p-4 pr-6 text-right text-sm font-medium text-muted-foreground"
              >
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {filteredWebhooks.map((webhook) => {
              const status = getWebhookStatus(webhook);

              return (
                <tr key={webhook.id} className="border-b last:border-0 align-top">
                  <td className="p-4 pl-6">
                    <div className="space-y-1">
                      <p className="text-sm font-medium">
                        {webhook.name?.trim() || 'Unnamed webhook'}
                      </p>
                      <p className="text-xs text-muted-foreground">{webhook.id}</p>
                    </div>
                  </td>
                  <td className="p-4">
                    <Badge variant="outline">{WEBHOOK_FORMAT_LABELS[webhook.format]}</Badge>
                  </td>
                  <td className="p-4">
                    <div className="flex max-w-sm flex-wrap gap-2">
                      {webhook.Events.filter((event) => railEvents.includes(event)).map((event) => (
                        <Badge key={event} variant="secondary" className="font-medium">
                          {WEBHOOK_EVENT_LABELS[event]}
                        </Badge>
                      ))}
                    </div>
                  </td>
                  <td className="p-4">
                    <div className="max-w-xs">
                      <p className="truncate text-sm" title={webhook.url}>
                        {webhook.url}
                      </p>
                    </div>
                  </td>
                  <td className="p-4">
                    <Badge variant={status === 'Active' ? 'success' : 'secondary'}>{status}</Badge>
                  </td>
                  <td className="p-4 text-sm text-muted-foreground">
                    {formatWebhookDate(webhook.lastSuccessAt)}
                  </td>
                  <td className="p-4 text-sm">{webhook.failureCount}</td>
                  <td className="p-4 text-sm text-muted-foreground">
                    {formatWebhookDate(webhook.updatedAt)}
                  </td>
                  <td className="p-4 pr-6">
                    <div className="flex justify-end gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => void handleSendTestWebhook(webhook)}
                        disabled={testingWebhookId === webhook.id}
                      >
                        {testingWebhookId === webhook.id ? 'Testing...' : 'Send test'}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setWebhookToEdit(webhook)}
                      >
                        <Pencil className="h-4 w-4" />
                        Edit
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setWebhookToDelete(webhook)}
                      >
                        <Trash2 className="h-4 w-4" />
                        Delete
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  };

  return (
    <MainLayout>
      <Head>
        <title>Webhooks | Admin Interface</title>
      </Head>
      <AnimatedPage>
        <div className="space-y-6">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <h1 className="text-2xl font-semibold tracking-tight">Webhooks</h1>
                <Badge variant="outline">
                  {activeRail === 'x402' ? 'x402 events' : 'Cardano events'}
                </Badge>
              </div>
              <p className="text-sm text-muted-foreground">
                {activeRail === 'x402'
                  ? 'Send x402 payment events to custom endpoints, Slack, Google Chat, or Discord. '
                  : 'Send Cardano payment source events to custom endpoints, Slack, Google Chat, or Discord. '}
                <Link
                  href="https://docs.masumi.network/api-reference/payment-service/post-webhooks"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  Learn more
                </Link>
              </p>
              {selectedPaymentSource && (
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <Badge variant="secondary">{selectedPaymentSource.network}</Badge>
                  <span>Selected payment source</span>
                  <span className="font-medium text-foreground">
                    {shortenAddress(selectedPaymentSource.smartContractAddress, 8)}
                  </span>
                </div>
              )}
            </div>

            <div className="flex items-center gap-2">
              <RefreshButton onRefresh={() => void refetch()} isRefreshing={isFetching} />
              <Button
                id="add-webhook-button"
                onClick={() => setIsAddDialogOpen(true)}
                disabled={!selectedPaymentSourceId}
              >
                <Plus className="h-4 w-4" />
                Add webhook
              </Button>
            </div>
          </div>

          {!selectedPaymentSourceId ? (
            <div className="rounded-lg border">
              <EmptyState
                title="Choose a payment source first"
                description="Use the payment source selector in the sidebar to choose the context for this webhook dashboard."
                action={
                  <Button variant="outline" onClick={() => router.push('/payment-sources')}>
                    <RefreshCw className="h-4 w-4" />
                    Open payment sources
                  </Button>
                }
              />
            </div>
          ) : (
            <>
              <Tabs
                tabs={tabs}
                activeTab={activeFormatTab}
                onTabChange={(tab) =>
                  setActiveFormatTab(tab as (typeof formatTabs)[number]['name'])
                }
              />

              <div className="space-y-4">
                <div className="flex items-center justify-between gap-4">
                  <SearchInput
                    value={searchQuery}
                    onChange={setSearchQuery}
                    placeholder="Search by name, URL, format, or event..."
                    className="max-w-sm"
                    isLoading={isFetching && !isLoading}
                  />
                </div>

                <div className="flex flex-wrap gap-2">
                  {eventFilterOptions.map((option) => {
                    const isActive = effectiveEventFilter === option.value;

                    return (
                      <Button
                        key={option.value}
                        type="button"
                        variant={isActive ? 'secondary' : 'outline'}
                        size="sm2"
                        onClick={() =>
                          setActiveEventFilter(
                            option.value as typeof allEventsFilterValue | WebhookEvent,
                          )
                        }
                      >
                        {option.label}
                      </Button>
                    );
                  })}
                </div>
              </div>

              {renderTable()}
            </>
          )}
        </div>
      </AnimatedPage>

      {selectedPaymentSourceId && (
        <>
          <WebhookDialog
            open={isAddDialogOpen}
            mode="create"
            paymentSourceId={selectedPaymentSourceId}
            availableEvents={railEvents}
            onClose={() => setIsAddDialogOpen(false)}
            onSuccess={() => void refetch()}
          />

          <WebhookDialog
            open={!!webhookToEdit}
            mode="edit"
            paymentSourceId={selectedPaymentSourceId}
            webhook={webhookToEdit}
            availableEvents={railEvents}
            onClose={() => setWebhookToEdit(null)}
            onSuccess={() => void refetch()}
          />
        </>
      )}

      <ConfirmDialog
        open={!!webhookToDelete}
        onClose={() => setWebhookToDelete(null)}
        title="Delete webhook"
        description={`Delete "${webhookToDelete?.name?.trim() || 'this webhook'}"? This action cannot be undone.`}
        onConfirm={() => void handleDeleteWebhook()}
        isLoading={isDeleting}
      />
    </MainLayout>
  );
}
