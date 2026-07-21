import { Button } from '@/components/ui/button';
import { formatDateTime } from '@/lib/format-date';
import { Input } from '@/components/ui/input';
import { MainLayout } from '@/components/layout/MainLayout';
import { Plus, Trash2, Edit2, Wand2, AlertTriangle, ShieldCheck, Eye, EyeOff } from 'lucide-react';
import { RefreshButton } from '@/components/RefreshButton';
import { useState, useEffect, useMemo } from 'react';
import { AddSourceDialog } from '@/components/payment-sources/AddSourceDialog';
import { X402SourcesSection } from '@/components/payment-sources/X402SourcesSection';
import { rowActivation } from '@/lib/a11y';
import { PaymentSourceDialog } from '@/components/payment-sources/PaymentSourceDialog';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { invalidateAgentQueries } from '@/lib/queries/agent-cache';
import { useAppContext } from '@/lib/contexts/AppContext';
import {
  deletePaymentSourceExtended,
  patchPaymentSourceExtended,
  PaymentSourceExtended,
} from '@/lib/api/generated';
import { toast } from 'react-toastify';

import { shortenAddress, cn } from '@/lib/utils';
import Head from 'next/head';
import { PaymentSourceTableSkeleton } from '@/components/skeletons/PaymentSourceTableSkeleton';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { CopyButton } from '@/components/ui/copy-button';
import { Badge } from '@/components/ui/badge';
import { AnimatedPage } from '@/components/ui/animated-page';
import { SearchInput } from '@/components/ui/search-input';
import { EmptyState } from '@/components/ui/empty-state';
import { BadgeWithTooltip } from '@/components/ui/badge-with-tooltip';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { TOOLTIP_TEXTS } from '@/lib/constants/tooltips';
import { useApiMutation } from '@/lib/hooks/useApiMutation';
import { useRouter } from 'next/router';
import { usePaymentSourceExtendedAll } from '@/lib/hooks/usePaymentSourceExtendedAll';
import { useRailReadiness } from '@/lib/hooks/useRailReadiness';
import { extractApiErrorMessage } from '@/lib/api-error';
import { PaymentSourceTypeBadge } from '@/components/payment-sources/PaymentSourceTypeBadge';
import { PaymentSourceSyncBadge } from '@/components/payment-sources/PaymentSourceSyncBadge';
import {
  DEFAULT_PAYMENT_SOURCE_TYPE,
  getPaymentSourceTypeLabel,
  isV2PaymentSource,
} from '@/lib/payment-source-type';

interface UpdatePaymentSourceDialogProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
  paymentSourceId: string;
  currentApiKey: string;
}

function UpdatePaymentSourceDialog({
  open,
  onClose,
  onSuccess,
  paymentSourceId,
  currentApiKey,
}: UpdatePaymentSourceDialogProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [apiKey, setApiKey] = useState(currentApiKey);
  // Blockfrost API key is a long-lived secret. Mask by default; user reveals
  // explicitly via the eye toggle. Without this the existing key renders in
  // plaintext as the dialog opens — visible to screen-share, screenshots,
  // and over-the-shoulder readers.
  const [showApiKey, setShowApiKey] = useState(false);
  const { apiClient } = useAppContext();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    setIsLoading(true);

    const response = await patchPaymentSourceExtended({
      client: apiClient,
      body: {
        id: paymentSourceId,
        PaymentSourceConfig: {
          rpcProviderApiKey: apiKey,
          rpcProvider: 'Blockfrost',
        },
      },
    });

    if (response.error) {
      console.error('Error updating payment source:', response.error);
      toast.error(extractApiErrorMessage(response.error, 'Failed to update payment source'));
      setIsLoading(false);
      return;
    }

    toast.success('Payment source updated successfully');
    onSuccess();
    onClose();
    setIsLoading(false);
  };

  return (
    <Dialog open={open} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Update Payment Source</DialogTitle>
          <DialogDescription>
            Update the Blockfrost API key for this payment source.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <label
              htmlFor="apiKey"
              className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
            >
              Blockfrost API Key
            </label>
            <div className="relative">
              <Input
                id="apiKey"
                type={showApiKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="Enter Blockfrost API key"
                autoComplete="off"
                spellCheck={false}
                required
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowApiKey((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label={showApiKey ? 'Hide API key' : 'Show API key'}
                tabIndex={-1}
              >
                {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          <div className="flex justify-end gap-3">
            <Button type="button" variant="outline" onClick={onClose} disabled={isLoading}>
              Cancel
            </Button>
            <Button type="submit" disabled={isLoading}>
              {isLoading ? 'Updating...' : 'Update'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function PaymentSourcesPage() {
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState('');
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);

  const [sourceToDelete, setSourceToDelete] = useState<PaymentSourceExtended | null>(null);
  const [sourceToUpdate, setSourceToUpdate] = useState<PaymentSourceExtended | null>(null);
  const deleteSourceMutation = useApiMutation({
    mutationFn: (body: { id: string }) => deletePaymentSourceExtended({ client: apiClient, body }),
    errorMessage: 'Failed to delete payment source',
  });
  const isDeleting = deleteSourceMutation.isPending;
  const { apiClient, selectedPaymentSourceId, network, setSelectedPaymentSourceId, setActiveRail } =
    useAppContext();
  const { paymentSources: ps, isLoading, refetch } = usePaymentSourceExtendedAll();
  const queryClient = useQueryClient();

  const paymentSources = useMemo(() => ps.filter((p) => p.network === network), [ps, network]);

  const filteredPaymentSources = useMemo(() => {
    if (!searchQuery) return [...paymentSources];
    const query = searchQuery.toLowerCase();
    return paymentSources.filter((source) => {
      const matchAddress = source.smartContractAddress?.toLowerCase().includes(query) || false;
      const matchNetwork = source.network?.toLowerCase().includes(query) || false;
      const matchType = source.paymentSourceType.toLowerCase().includes(query);
      return matchAddress || matchNetwork || matchType;
    });
  }, [paymentSources, searchQuery]);

  const v2Sources = useMemo(() => paymentSources.filter(isV2PaymentSource), [paymentSources]);
  const legacySources = useMemo(
    () => paymentSources.filter((source) => !isV2PaymentSource(source)),
    [paymentSources],
  );
  const hasV2Source = v2Sources.length > 0;
  const hasLegacyOnly = legacySources.length > 0 && !hasV2Source;
  // "A V2 row exists" is not the same as "V2 works": a source with no selling
  // wallet, no Blockfrost key or a retired contract would still have shown the
  // green "ready" banner. Readiness is the backend's call; the row count only
  // decides which copy to show while it is still incomplete.
  const {
    cardano: cardanoReadiness,
    isLoading: isLoadingReadiness,
    isUnavailable: isReadinessUnavailable,
  } = useRailReadiness();
  // If readiness could not be fetched, fall back to the old row-exists
  // heuristic rather than asserting either state: wrong in the same way it was
  // before this endpoint existed, instead of newly alarming on every blip.
  const isV2Ready = isReadinessUnavailable ? hasV2Source : (cardanoReadiness?.isReady ?? false);
  const firstBlockingCheck = cardanoReadiness?.Checks.find((check) => !check.isComplete) ?? null;
  // Stay neutral rather than alarming while readiness is still resolving.
  const needsV2Setup = !isLoadingReadiness && !isV2Ready;

  const [sourceToSelect, setSourceToSelect] = useState<PaymentSourceExtended | undefined>(
    undefined,
  );
  const [selectedPaymentSourceForDetails, setSelectedPaymentSourceForDetails] =
    useState<PaymentSourceExtended | null>(null);

  useEffect(() => {
    if (router.query.action === 'add_payment_source') {
      queueMicrotask(() => setIsAddDialogOpen(true));
      router.replace('/payment-sources', undefined, { shallow: true });
    }
  }, [router.query.action, router]);

  const handleDeleteSource = async () => {
    if (!sourceToDelete) return;

    const response = await deleteSourceMutation
      .mutateAsync({ id: sourceToDelete.id })
      .catch((error: unknown) => {
        console.error('Error deleting payment source:', error);
        return null;
      });
    setSourceToDelete(null);
    if (!response) return;

    toast.success('Payment source deleted successfully');
    refetch();
    // Dashboard cards keyed by selectedPaymentSourceId continue
    // rendering against caches that no longer match a live source.
    // Invalidate sibling queries so wallets / transactions / agents
    // refetch against whatever source the user selects next instead
    // of showing rows from the deleted one until the next ~25s tick.
    queryClient.invalidateQueries({ queryKey: ['payment-sources-all'] });
    queryClient.invalidateQueries({ queryKey: ['wallets'] });
    queryClient.invalidateQueries({ queryKey: ['transactions'] });
    invalidateAgentQueries(queryClient);
  };

  return (
    <MainLayout>
      <Head>
        <title>Payment Sources | Admin Interface</title>
      </Head>
      <AnimatedPage>
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-2xl font-semibold">Payment Sources</h1>
                <BadgeWithTooltip
                  text="?"
                  tooltipText={TOOLTIP_TEXTS.PAYMENT_SOURCES}
                  variant="outline"
                  className="text-xs w-5 h-5 rounded-full p-0 flex items-center justify-center cursor-help"
                />
              </div>
              <p className="text-sm text-muted-foreground">
                Manage your payment sources.{' '}
                <Link
                  href="https://www.masumi.network/dev/masumi/api-reference/payment-service/get-payment-source"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  Learn more
                </Link>
              </p>
            </div>
            <div className="flex items-center gap-2">
              <RefreshButton
                onRefresh={() => {
                  void refetch();
                }}
                isRefreshing={isLoading}
              />
              <Button
                className="flex items-center gap-2 btn-hover-lift"
                onClick={() => setIsAddDialogOpen(true)}
              >
                <Plus className="h-4 w-4" />
                Add source
              </Button>
            </div>
          </div>

          <div
            className={cn(
              'rounded-lg border px-4 py-3',
              needsV2Setup
                ? 'border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-100'
                : 'border-green-200 bg-green-50 text-green-950 dark:border-green-900/50 dark:bg-green-950/20 dark:text-green-100',
            )}
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex gap-3">
                {needsV2Setup ? (
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-300" />
                ) : (
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-green-600 dark:text-green-300" />
                )}
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium">
                      {isV2Ready
                        ? 'V2 payment source ready'
                        : hasV2Source
                          ? 'Finish V2 payment source setup'
                          : hasLegacyOnly
                            ? 'Set up V2 before migrating agents'
                            : 'Set up V2 for new agents'}
                    </p>
                    <PaymentSourceTypeBadge
                      paymentSourceType={DEFAULT_PAYMENT_SOURCE_TYPE}
                      showDefault
                    />
                  </div>
                  <p className="max-w-3xl text-sm opacity-85">
                    {hasV2Source && !isV2Ready && firstBlockingCheck
                      ? `${firstBlockingCheck.label}: ${firstBlockingCheck.detail ?? 'not configured yet'}`
                      : legacySources.length > 0
                        ? 'V2 is the default for new agents. Create the V2 source, migrate V1 agents to the V2 registry, then delete the old source after it is no longer used.'
                        : 'V2 is the default for new agents. Create a V2 source to use the new registry metadata and zero-fee payment source behavior.'}
                  </p>
                </div>
              </div>
              {needsV2Setup && (
                <Button size="sm" asChild className="shrink-0">
                  <Link href={`/setup?network=${network}`}>Set up V2</Link>
                </Button>
              )}
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            <div className="rounded-lg border bg-card px-4 py-3">
              <p className="text-xs font-medium uppercase text-muted-foreground">Default</p>
              <p className="mt-1 text-sm font-semibold">
                {getPaymentSourceTypeLabel(DEFAULT_PAYMENT_SOURCE_TYPE)}
              </p>
            </div>
            <div className="rounded-lg border bg-card px-4 py-3">
              <p className="text-xs font-medium uppercase text-muted-foreground">V2 sources</p>
              <p className="mt-1 text-sm font-semibold">{v2Sources.length}</p>
            </div>
            <div className="rounded-lg border bg-card px-4 py-3">
              <p className="text-xs font-medium uppercase text-muted-foreground">
                Legacy V1 sources
              </p>
              <p className="mt-1 text-sm font-semibold">{legacySources.length}</p>
            </div>
          </div>

          <div className="space-y-6">
            <div className="flex items-center justify-between gap-4">
              <div className="flex-1">
                <SearchInput
                  value={searchQuery}
                  onChange={setSearchQuery}
                  placeholder="Search address, network, or type"
                  className="max-w-xs"
                />
              </div>
            </div>

            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold">Cardano payment sources</h2>
              <Badge
                variant="outline"
                className="border-sky-300 bg-sky-50 px-1.5 py-0 text-[10px] font-medium text-sky-700 dark:border-sky-900/60 dark:bg-sky-950/30 dark:text-sky-300"
              >
                Cardano
              </Badge>
            </div>

            <div className="rounded-lg border overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b">
                    <th scope="col" className="p-4 text-left text-sm font-medium truncate pl-6">
                      Contract address
                    </th>
                    <th scope="col" className="p-4 text-left text-sm font-medium">
                      Type
                    </th>
                    <th scope="col" className="p-4 text-left text-sm font-medium">
                      ID
                    </th>
                    <th scope="col" className="p-4 text-left text-sm font-medium">
                      Network
                    </th>
                    <th scope="col" className="p-4 text-left text-sm font-medium truncate">
                      Fee rate (%)
                    </th>
                    <th scope="col" className="p-4 text-left text-sm font-medium truncate">
                      Created at
                    </th>
                    <th scope="col" className="p-4 text-left text-sm font-medium">
                      Wallets
                    </th>
                    <th scope="col" className="w-20 p-4 pr-8"></th>
                  </tr>
                </thead>
                <tbody>
                  {isLoading ? (
                    <PaymentSourceTableSkeleton rows={5} />
                  ) : filteredPaymentSources.length === 0 ? (
                    <tr>
                      <td colSpan={8}>
                        <EmptyState
                          icon="inbox"
                          title="No payment sources found"
                          description="Add a payment source to get started"
                          action={
                            <Button asChild>
                              <Link href={`/setup?network=${network}`}>
                                <Wand2 className="h-4 w-4 mr-2" />
                                Set up for {network}
                              </Link>
                            </Button>
                          }
                        />
                      </td>
                    </tr>
                  ) : (
                    filteredPaymentSources.map((source, index) => (
                      <tr
                        key={source.id}
                        className={cn(
                          'border-b last:border-b-0 cursor-pointer hover:bg-muted/50 transition-[background-color,opacity] duration-150 animate-fade-in opacity-0',
                          selectedPaymentSourceId === source.id &&
                            'bg-green-50 dark:bg-green-950/20',
                        )}
                        style={{ animationDelay: `${Math.min(index, 9) * 40}ms` }}
                        aria-label="View payment source details"
                        onClick={() => setSelectedPaymentSourceForDetails(source)}
                        {...rowActivation(() => setSelectedPaymentSourceForDetails(source))}
                      >
                        <td
                          className={cn(
                            'p-4 pl-6',
                            selectedPaymentSourceId === source.id &&
                              'border-l-4 border-l-green-500',
                          )}
                        >
                          <div className="text-xs text-muted-foreground font-mono truncate max-w-[200px] flex items-center gap-2">
                            {shortenAddress(source.smartContractAddress)}{' '}
                            <CopyButton value={source.smartContractAddress} />
                          </div>
                        </td>
                        <td className="p-4">
                          <div className="flex flex-wrap items-center gap-2">
                            <PaymentSourceTypeBadge
                              paymentSourceType={source.paymentSourceType}
                              showDefault
                            />
                            <PaymentSourceSyncBadge status={source.contractSyncStatus} />
                          </div>
                        </td>
                        <td className="p-4">
                          <div className="text-sm flex items-center gap-2">
                            {shortenAddress(source.id)}
                            <CopyButton value={source.id} />
                          </div>
                        </td>
                        <td className="p-4">
                          <div className="text-sm">{source.network}</div>
                        </td>
                        <td className="p-4">
                          <div className="text-sm">
                            {(source.feeRatePermille / 10).toFixed(1)}%
                            {isV2PaymentSource(source) && (
                              <span className="ml-1 text-xs text-muted-foreground">fixed</span>
                            )}
                          </div>
                        </td>
                        <td className="p-4">
                          <div className="text-xs text-muted-foreground">
                            {formatDateTime(source.createdAt)}
                          </div>
                        </td>
                        <td className="p-4">
                          <div className="text-xs text-muted-foreground">
                            <span className="block truncate">
                              {source.PurchasingWalletsCount} Buying,
                            </span>
                            <span className="block truncate">
                              {source.SellingWalletsCount} Selling
                            </span>
                          </div>
                        </td>
                        <td className="p-4 pr-8" onClick={(e) => e.stopPropagation()}>
                          <div className="flex gap-2">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setSourceToUpdate(source)}
                              className="text-primary hover:text-primary hover:bg-primary/10"
                            >
                              <Edit2 className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setSourceToDelete(source)}
                              className="text-destructive hover:text-destructive hover:bg-destructive/10 group"
                            >
                              <Trash2 className="h-4 w-4 transition-transform duration-200 group-hover:scale-110" />
                            </Button>

                            {selectedPaymentSourceId === source.id ? (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Badge
                                    variant="success"
                                    className="flex items-center gap-1.5 px-3 py-1 cursor-help"
                                  >
                                    <span className="w-1.5 h-1.5 rounded-full bg-green-500 dark:bg-green-400 animate-subtle-pulse" />
                                    Active
                                  </Badge>
                                </TooltipTrigger>
                                <TooltipContent>
                                  <p className="text-sm max-w-[200px]">
                                    This payment source is currently active. All agents, wallets,
                                    and transactions shown are from this source.
                                  </p>
                                </TooltipContent>
                              </Tooltip>
                            ) : (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setSourceToSelect(source)}
                              >
                                Set as Active
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <X402SourcesSection network={network} searchQuery={searchQuery} />
          </div>

          <AddSourceDialog open={isAddDialogOpen} onClose={() => setIsAddDialogOpen(false)} />

          {/* Remount per source: the dialog seeds its apiKey state once from
              currentApiKey, so without a key the field would keep stale text
              typed for a previously edited source. */}
          <UpdatePaymentSourceDialog
            key={sourceToUpdate?.id ?? 'closed'}
            open={!!sourceToUpdate}
            onClose={() => setSourceToUpdate(null)}
            onSuccess={() => {
              refetch();
            }}
            paymentSourceId={sourceToUpdate?.id || ''}
            currentApiKey={sourceToUpdate?.PaymentSourceConfig?.rpcProviderApiKey || ''}
          />

          <ConfirmDialog
            open={!!sourceToDelete}
            onClose={() => setSourceToDelete(null)}
            title="Delete Payment Source"
            description={`Are you sure you want to delete this payment source? This will also delete all associated wallets and transactions. This action cannot be undone.`}
            onConfirm={handleDeleteSource}
            isLoading={isDeleting}
            requireConfirmation={true}
            confirmationText="DELETE"
            confirmationLabel="Type 'DELETE' to confirm deletion"
          />

          <ConfirmDialog
            open={sourceToSelect !== undefined}
            onClose={() => setSourceToSelect(undefined)}
            title="Set as Active Payment Source"
            description={`Setting this as the active source will change which agents, wallets, and transactions are displayed across the admin interface.\n\nType: ${sourceToSelect?.paymentSourceType ? getPaymentSourceTypeLabel(sourceToSelect.paymentSourceType) : ''}\nContract Address: ${sourceToSelect?.smartContractAddress ? shortenAddress(sourceToSelect.smartContractAddress) : ''}`}
            onConfirm={() => {
              if (sourceToSelect?.id) {
                // A Cardano source is a Cardano-rail context; switch the rail too so the
                // sidebar/pages don't stay in x402 context after activating it.
                setActiveRail('cardano');
                setSelectedPaymentSourceId(sourceToSelect.id);
              }
              setSourceToSelect(undefined);
            }}
            isLoading={false}
          />

          <PaymentSourceDialog
            open={!!selectedPaymentSourceForDetails}
            onClose={() => setSelectedPaymentSourceForDetails(null)}
            paymentSource={selectedPaymentSourceForDetails}
          />
        </div>
      </AnimatedPage>
    </MainLayout>
  );
}
