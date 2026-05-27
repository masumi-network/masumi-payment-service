import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Separator } from '@/components/ui/separator';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Info,
  PlusCircle,
  RefreshCcw,
  ShieldCheck,
  Wallet,
} from 'lucide-react';
import { useAppContext } from '@/lib/contexts/AppContext';
import { usePaymentSourceExtendedAll } from '@/lib/hooks/usePaymentSourceExtendedAll';
import {
  getRegistry,
  postRegistry,
  postRegistryDeregister,
  type PaymentSourceExtended,
  type RegistryEntry,
} from '@/lib/api/generated';
import { isV2PaymentSource } from '@/lib/payment-source-type';
import { fetchWalletBalance } from '@/lib/queries/useWallets';
import { cn, handleApiCall, shortenAddress } from '@/lib/utils';
import { extractApiErrorMessage } from '@/lib/api-error';
import { TransakWidget } from '@/components/wallets/TransakWidget';
import { appendInclusiveCursorPage } from '@/lib/pagination/cursor-pagination';

const MIN_MIGRATION_BALANCE_LOVELACE = 5_000_000; // ~5 ADA buffer per agent mint
const REGISTRY_FETCH_LIMIT = 100;

type MigrationStatus = 'pending' | 'running' | 'success' | 'failed';

interface MigrationResult {
  agentId: string;
  status: MigrationStatus;
  error?: string;
  // Non-fatal: re-register succeeded but the V1 deregister leg failed. Surface
  // it inline so the user knows the V1 entry is still live and needs manual
  // cleanup from the AI Agents page.
  deregisterError?: string;
}

interface MigrateAgentsDialogProps {
  open: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

// Resolves what `recipientWalletAddress` we should send to the V2 register
// endpoint AND, separately, surfaces any V1 holding address that will be
// silently dropped because no matching managed wallet exists on the V2
// source. Single source of truth so `buildRegistryBody` and the row warning
// can't disagree about whether routing is preserved.
function resolveV2HoldingAddress(
  agent: RegistryEntry,
  v2Source: PaymentSourceExtended | undefined,
): { v2HoldingAddress: string | undefined; droppedV1HoldingAddress: string | null } {
  const v1HoldingWallet =
    agent.RecipientWallet &&
    agent.RecipientWallet.walletVkey !== agent.SmartContractWallet.walletVkey
      ? agent.RecipientWallet
      : null;
  if (!v1HoldingWallet) {
    return { v2HoldingAddress: undefined, droppedV1HoldingAddress: null };
  }
  if (!v2Source) {
    return { v2HoldingAddress: undefined, droppedV1HoldingAddress: v1HoldingWallet.walletAddress };
  }
  const onV2 = [...(v2Source.SellingWallets ?? []), ...(v2Source.PurchasingWallets ?? [])].some(
    (w) => w.walletAddress === v1HoldingWallet.walletAddress,
  );
  return onV2
    ? { v2HoldingAddress: v1HoldingWallet.walletAddress, droppedV1HoldingAddress: null }
    : { v2HoldingAddress: undefined, droppedV1HoldingAddress: v1HoldingWallet.walletAddress };
}

async function fetchAllRegistryEntries(args: {
  apiClient: ReturnType<typeof useAppContext>['apiClient'];
  network: 'Preprod' | 'Mainnet';
  smartContractAddress: string;
}) {
  // The /registry cursor is inclusive (Prisma `cursor: { id: cursorId }` returns
  // the cursor row again as the first item of the next page). Dedup across page
  // boundaries via the shared cursor helper so the migration list never shows
  // duplicates or re-registers an agent twice.
  let entries: RegistryEntry[] = [];
  let cursor: string | undefined;

  while (true) {
    const response = await handleApiCall(
      () =>
        getRegistry({
          client: args.apiClient,
          query: {
            network: args.network,
            cursorId: cursor,
            filterSmartContractAddress: args.smartContractAddress,
            limit: REGISTRY_FETCH_LIMIT,
            filterStatus: 'Registered',
          },
        }),
      { errorMessage: 'Failed to load V1 agents' },
    );

    const page = response?.data?.data?.Assets ?? [];
    if (page.length === 0) break;
    // Backend `filterStatus: 'Registered'` is inclusive of `DeregistrationFailed`
    // (see src/routes/api/registry/queries.ts) — exclude those here to avoid
    // re-attempting bad deregisters during V2 migration and to keep the list
    // limited to V1 entries that are actually safe to re-register.
    const filteredPage = page.filter((entry) => entry.state !== 'DeregistrationFailed');
    entries = appendInclusiveCursorPage(entries, filteredPage, (a) => a.id);
    if (page.length < REGISTRY_FETCH_LIMIT) break;
    const last = page[page.length - 1];
    if (!last?.id || last.id === cursor) break;
    // NOTE: we do NOT break here when `filteredPage` was empty even though
    // `page` was full. A full page of nothing-but-`DeregistrationFailed`
    // entries is legitimate and the NEXT cursor advance can still surface
    // valid `Registered` entries. The cursor-equality check above handles
    // the only real infinite-loop risk (server returns the same id).
    cursor = last.id;
  }

  return entries;
}

export function MigrateAgentsDialog({ open, onClose, onSuccess }: MigrateAgentsDialogProps) {
  const { apiClient, network } = useAppContext();
  const {
    paymentSources,
    isLoading: isLoadingSources,
    refetch: refetchSources,
  } = usePaymentSourceExtendedAll();
  const queryClient = useQueryClient();

  const currentNetworkSources = useMemo(
    () => paymentSources.filter((ps) => ps.network === network),
    [paymentSources, network],
  );
  const v2Source = useMemo<PaymentSourceExtended | undefined>(
    () => currentNetworkSources.find(isV2PaymentSource),
    [currentNetworkSources],
  );
  const v1Sources = useMemo(
    () => currentNetworkSources.filter((s) => !isV2PaymentSource(s)),
    [currentNetworkSources],
  );

  const [selectedV1SourceId, setSelectedV1SourceId] = useState<string>('');
  useEffect(() => {
    if (!open) return;
    if (selectedV1SourceId && v1Sources.some((s) => s.id === selectedV1SourceId)) return;
    setSelectedV1SourceId(v1Sources[0]?.id ?? '');
  }, [open, v1Sources, selectedV1SourceId]);

  const selectedV1Source = useMemo(
    () => v1Sources.find((s) => s.id === selectedV1SourceId),
    [v1Sources, selectedV1SourceId],
  );

  const v2SellingWallets = useMemo(() => v2Source?.SellingWallets ?? [], [v2Source]);
  const [selectedV2WalletVkey, setSelectedV2WalletVkey] = useState<string>('');
  useEffect(() => {
    if (!open) return;
    if (selectedV2WalletVkey && v2SellingWallets.some((w) => w.walletVkey === selectedV2WalletVkey))
      return;
    setSelectedV2WalletVkey(v2SellingWallets[0]?.walletVkey ?? '');
  }, [open, v2SellingWallets, selectedV2WalletVkey]);

  const selectedV2Wallet = useMemo(
    () => v2SellingWallets.find((w) => w.walletVkey === selectedV2WalletVkey),
    [v2SellingWallets, selectedV2WalletVkey],
  );

  // Load V1 agents for the selected V1 source
  const v1AgentsQuery = useQuery<RegistryEntry[]>({
    queryKey: ['migrate-v1-agents', network, selectedV1Source?.smartContractAddress ?? ''],
    queryFn: () =>
      fetchAllRegistryEntries({
        apiClient,
        network,
        smartContractAddress: selectedV1Source!.smartContractAddress,
      }),
    enabled: open && !!selectedV1Source,
    staleTime: 15_000,
  });
  const v1Agents = useMemo(() => v1AgentsQuery.data ?? [], [v1AgentsQuery.data]);

  // Agents whose V1 holding wallet has no V2 counterpart — funds re-routed to
  // the V2 selling wallet on migrate. Keyed by agent.id so per-row render and
  // the selected-count summary share one computation.
  const droppedHoldingByAgentId = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of v1Agents) {
      const { droppedV1HoldingAddress } = resolveV2HoldingAddress(a, v2Source);
      if (droppedV1HoldingAddress) map.set(a.id, droppedV1HoldingAddress);
    }
    return map;
  }, [v1Agents, v2Source]);

  const [selectedAgentIds, setSelectedAgentIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!open) return;
    setSelectedAgentIds((prev) => {
      const next = new Set<string>();
      for (const id of prev) {
        if (v1Agents.some((a) => a.id === id)) next.add(id);
      }
      return next;
    });
  }, [open, v1Agents]);

  // Fetch balance of selected V2 wallet
  const [walletBalance, setWalletBalance] = useState<number | null>(null);
  const [isLoadingBalance, setIsLoadingBalance] = useState(false);
  const [showTopup, setShowTopup] = useState(false);
  // Epoch counter prevents stale balance writes when the user changes wallet,
  // closes the dialog, or rapidly clicks Refresh — only the latest in-flight
  // request is allowed to set state. fetchWalletBalance has no AbortSignal
  // hook today, so this is the cheapest sound guard.
  const balanceFetchEpochRef = useRef(0);

  const refreshBalance = useCallback(async () => {
    if (!selectedV2Wallet) {
      setWalletBalance(null);
      return;
    }
    const epoch = ++balanceFetchEpochRef.current;
    const targetAddress = selectedV2Wallet.walletAddress;
    setIsLoadingBalance(true);
    try {
      const result = await fetchWalletBalance(apiClient, network, targetAddress);
      if (balanceFetchEpochRef.current !== epoch) return;
      setWalletBalance(parseInt(result.ada || '0', 10) || 0);
    } catch (err) {
      // Swallow the error so the spinner clears (finally below) — surfacing a
      // toast on every transient balance-fetch failure would be noisy, but we
      // still want a trace for debugging.
      console.error('[MigrateAgentsDialog] fetchWalletBalance failed', err);
    } finally {
      if (balanceFetchEpochRef.current === epoch) {
        setIsLoadingBalance(false);
      }
    }
  }, [apiClient, network, selectedV2Wallet]);

  useEffect(() => {
    if (!open || !selectedV2Wallet) {
      // Invalidate any in-flight fetch so its late response is dropped.
      balanceFetchEpochRef.current += 1;
      setWalletBalance(null);
      setIsLoadingBalance(false);
      return;
    }
    void refreshBalance();
  }, [open, selectedV2Wallet, refreshBalance]);

  const requiredBalance = Math.max(
    MIN_MIGRATION_BALANCE_LOVELACE,
    selectedAgentIds.size * MIN_MIGRATION_BALANCE_LOVELACE,
  );
  const hasEnoughBalance = walletBalance !== null && walletBalance >= requiredBalance;

  // Migration execution
  const [results, setResults] = useState<Record<string, MigrationResult>>({});
  const [isMigrating, setIsMigrating] = useState(false);
  const [deregisterAfter, setDeregisterAfter] = useState(false);
  const [isDone, setIsDone] = useState(false);

  // Tracks whether the component is still mounted so the long-running
  // `runMigration` loop can bail out before calling state setters after unmount.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Defer invalidation of the dialog's own V1 list until the user dismisses
  // the success screen — otherwise the just-migrated rows disappear while the
  // user is still reading the results. Tracked as a ref so we don't need to
  // re-render when toggled.
  const hasPendingV1ListInvalidationRef = useRef(false);

  useEffect(() => {
    if (open) {
      setResults({});
      setIsDone(false);
      setIsMigrating(false);
    }
  }, [open]);

  const handleClose = useCallback(() => {
    if (hasPendingV1ListInvalidationRef.current) {
      hasPendingV1ListInvalidationRef.current = false;
      queryClient.invalidateQueries({ queryKey: ['migrate-v1-agents'] });
    }
    onClose();
  }, [onClose, queryClient]);

  const toggleAgent = (id: string) => {
    setSelectedAgentIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selectedAgentIds.size === v1Agents.length) {
      setSelectedAgentIds(new Set());
    } else {
      setSelectedAgentIds(new Set(v1Agents.map((a) => a.id)));
    }
  };

  const buildRegistryBody = (agent: RegistryEntry, walletVkey: string) => {
    const pricing = (() => {
      if (agent.AgentPricing.pricingType === 'Free') {
        return { pricingType: 'Free' as const };
      }
      if (agent.AgentPricing.pricingType === 'Dynamic') {
        return { pricingType: 'Dynamic' as const };
      }
      return {
        pricingType: 'Fixed' as const,
        Pricing: agent.AgentPricing.Pricing.map((p) => ({
          unit: p.unit,
          amount: p.amount,
        })),
      };
    })();

    const legal: Record<string, string> = {};
    if (agent.Legal.privacyPolicy) legal.privacyPolicy = agent.Legal.privacyPolicy;
    if (agent.Legal.terms) legal.terms = agent.Legal.terms;
    if (agent.Legal.other) legal.other = agent.Legal.other;

    const author: {
      name: string;
      contactEmail?: string;
      contactOther?: string;
      organization?: string;
    } = { name: agent.Author.name || 'Migrated Agent' };
    if (agent.Author.contactEmail) author.contactEmail = agent.Author.contactEmail;
    if (agent.Author.contactOther) author.contactOther = agent.Author.contactOther;
    if (agent.Author.organization) author.organization = agent.Author.organization;

    // Preserve V1's distinct holding wallet on V2 only when the same address
    // exists as a managed wallet on the V2 source — otherwise the backend
    // would reject the unknown address. The dropped case is also surfaced
    // per-row in the UI so the user can opt out before migrating instead of
    // silently inheriting the V2 selling wallet as their payout target.
    const { v2HoldingAddress } = resolveV2HoldingAddress(agent, v2Source);

    return {
      network,
      sellingWalletVkey: walletVkey,
      recipientWalletAddress: v2HoldingAddress,
      sendFundingLovelace:
        v2HoldingAddress && agent.sendFundingLovelace ? agent.sendFundingLovelace : undefined,
      name: agent.name,
      description: agent.description ?? agent.name,
      apiBaseUrl: agent.apiBaseUrl,
      Tags: agent.Tags,
      Capability: {
        name: agent.Capability.name ?? 'Custom Agent',
        version: agent.Capability.version ?? '1.0.0',
      },
      AgentPricing: pricing,
      Author: author,
      Legal: Object.keys(legal).length > 0 ? legal : undefined,
      ExampleOutputs: agent.ExampleOutputs.map((e) => ({
        name: e.name,
        url: e.url,
        mimeType: e.mimeType,
      })),
    };
  };

  const runMigration = async () => {
    if (!selectedV2Wallet) {
      toast.error('Select a V2 selling wallet first');
      return;
    }
    if (selectedAgentIds.size === 0) {
      toast.error('Select at least one agent to migrate');
      return;
    }
    if (!hasEnoughBalance) {
      toast.error('V2 wallet balance is too low; top up first');
      return;
    }

    setIsMigrating(true);
    setIsDone(false);

    // Pre-filter the selection against the current v1Agents list. Between
    // the user picking agents and clicking Migrate, the query can refetch
    // (window-focus, manual invalidate, concurrent tab, server-side mutation)
    // and drop entries. Iterating over v1Agents AFTER setting every selected
    // id to `pending` would leave dropped ids stuck on `pending` forever
    // and undercount successCount.
    const validAgents = v1Agents.filter((a) => selectedAgentIds.has(a.id));
    const droppedCount = selectedAgentIds.size - validAgents.length;
    if (droppedCount > 0) {
      toast.warning(
        `${droppedCount} selected agent(s) are no longer present in the V1 registry and were skipped`,
      );
    }

    const initial: Record<string, MigrationResult> = {};
    for (const agent of validAgents) {
      initial[agent.id] = { agentId: agent.id, status: 'pending' };
    }
    setResults(initial);

    let successCount = 0;

    for (const agent of validAgents) {
      if (!mountedRef.current) return;

      setResults((prev) => ({
        ...prev,
        [agent.id]: { agentId: agent.id, status: 'running' },
      }));

      try {
        const response = await postRegistry({
          client: apiClient,
          body: buildRegistryBody(agent, selectedV2Wallet.walletVkey),
        });

        if (response.error || !response.data?.data?.id) {
          throw new Error(extractApiErrorMessage(response.error, 'Failed to re-register on V2'));
        }

        let deregisterError: string | undefined;
        if (deregisterAfter) {
          if (!agent.agentIdentifier) {
            // Confirmed agents always have an agentIdentifier, but be explicit
            // about why we couldn't deregister in case of edge data.
            deregisterError =
              'V1 entry has no agentIdentifier (never minted) — cannot deregister automatically.';
          } else {
            try {
              const deregResp = await postRegistryDeregister({
                client: apiClient,
                body: {
                  network,
                  agentIdentifier: agent.agentIdentifier,
                },
              });
              if (deregResp.error) {
                deregisterError = extractApiErrorMessage(
                  deregResp.error,
                  'Failed to deregister V1 entry',
                );
              }
            } catch (err) {
              deregisterError = extractApiErrorMessage(err, 'Failed to deregister V1 entry');
            }
          }
        }

        if (!mountedRef.current) return;
        setResults((prev) => ({
          ...prev,
          [agent.id]: {
            agentId: agent.id,
            status: 'success',
            deregisterError,
          },
        }));
        successCount += 1;
      } catch (err) {
        if (!mountedRef.current) return;
        setResults((prev) => ({
          ...prev,
          [agent.id]: {
            agentId: agent.id,
            status: 'failed',
            error: extractApiErrorMessage(err, 'Migration failed'),
          },
        }));
      }
    }

    if (!mountedRef.current) return;
    setIsMigrating(false);
    setIsDone(true);

    if (successCount > 0) {
      toast.success(
        successCount === 1
          ? '1 agent re-registered on V2'
          : `${successCount} agents re-registered on V2`,
      );
      // Invalidate non-dialog queries immediately so the parent page reflects
      // the new V2 agents. Defer the dialog's own V1 list invalidation until
      // `handleClose` so the just-migrated rows stay visible on the success
      // screen — otherwise they vanish while the user is still reading results.
      queryClient.invalidateQueries({ queryKey: ['agents'] });
      queryClient.invalidateQueries({ queryKey: ['payment-sources-all'] });
      hasPendingV1ListInvalidationRef.current = true;
      onSuccess?.();
    }

    // Balance dropped after mint(s) — refresh so the user sees current state.
    void refreshBalance();
  };

  const renderBalanceState = () => {
    if (!selectedV2Wallet) return null;
    if (isLoadingBalance) {
      return (
        <span className="text-sm text-muted-foreground inline-flex items-center gap-2">
          <Spinner size={14} /> Loading balance…
        </span>
      );
    }
    if (walletBalance === null) return null;
    const adaBalance = walletBalance / 1_000_000;
    const requiredAda = requiredBalance / 1_000_000;
    return (
      <div className="flex flex-col gap-1 text-sm">
        <span>
          <span className="font-medium">{adaBalance.toFixed(2)} ADA</span> available
        </span>
        <span
          className={cn(
            'text-xs',
            hasEnoughBalance ? 'text-green-600 dark:text-green-500' : 'text-amber-600',
          )}
        >
          Need ~{requiredAda.toFixed(2)} ADA total (~5 ADA per agent for minting)
        </span>
      </div>
    );
  };

  const isLoading = isLoadingSources || (!!selectedV1Source && v1AgentsQuery.isLoading);

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => !o && !isMigrating && handleClose()}>
        <DialogContent className="sm:max-w-[700px] overflow-y-auto max-h-[90vh]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-primary" />
              Migrate agents to V2
            </DialogTitle>
            <DialogDescription>
              Re-register your V1 agents on the V2 registry. Each agent is minted fresh on the V2
              source — your V1 entries remain until you deregister them.
            </DialogDescription>
          </DialogHeader>

          {!v2Source && !isLoadingSources && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-900/50 dark:bg-amber-950/20 px-4 py-3 flex gap-3">
              <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-300 mt-0.5 shrink-0" />
              <div className="space-y-2 text-sm">
                <p className="font-medium text-amber-950 dark:text-amber-100">Set up V2 first</p>
                <p className="text-amber-900/80 dark:text-amber-100/80">
                  You need a V2 payment source on {network} before you can migrate agents. Run the
                  one-time setup wizard, then come back here.
                </p>
                <Button size="sm" asChild>
                  <a href={`/setup?network=${network}`}>Start V2 setup</a>
                </Button>
              </div>
            </div>
          )}

          {v1Sources.length === 0 && !isLoadingSources && (
            <div className="rounded-lg border bg-muted/30 px-4 py-6 text-center text-sm text-muted-foreground">
              No V1 payment source on {network} — nothing to migrate.
            </div>
          )}

          {v2Source && v1Sources.length > 0 && (
            <div className="space-y-5">
              {v1Sources.length > 1 && (
                <div className="space-y-2">
                  <Label className="text-sm">Migrate from V1 source</Label>
                  <Select value={selectedV1SourceId} onValueChange={setSelectedV1SourceId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select V1 source" />
                    </SelectTrigger>
                    <SelectContent>
                      {v1Sources.map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {shortenAddress(s.smartContractAddress)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              <div className="space-y-2">
                <Label className="text-sm">Target V2 selling wallet</Label>
                {v2SellingWallets.length === 0 ? (
                  <div className="rounded-lg border border-dashed bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
                    The V2 source has no selling wallets yet. Add one on the payment sources page.
                  </div>
                ) : (
                  <Select value={selectedV2WalletVkey} onValueChange={setSelectedV2WalletVkey}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select V2 wallet" />
                    </SelectTrigger>
                    <SelectContent>
                      {v2SellingWallets.map((w) => (
                        <SelectItem key={w.walletVkey} value={w.walletVkey}>
                          {w.note
                            ? `${w.note} (${shortenAddress(w.walletAddress)})`
                            : shortenAddress(w.walletAddress)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>

              {selectedV2Wallet && (
                <div
                  className={cn(
                    'rounded-lg border px-4 py-3',
                    hasEnoughBalance
                      ? 'border-green-200 bg-green-50/60 dark:border-green-900/50 dark:bg-green-950/20'
                      : 'border-amber-200 bg-amber-50 dark:border-amber-900/50 dark:bg-amber-950/20',
                  )}
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-start gap-3">
                      <Wallet
                        className={cn(
                          'h-4 w-4 mt-0.5 shrink-0',
                          hasEnoughBalance
                            ? 'text-green-600 dark:text-green-400'
                            : 'text-amber-600 dark:text-amber-300',
                        )}
                      />
                      <div>
                        <p className="text-xs font-mono">
                          {shortenAddress(selectedV2Wallet.walletAddress, 10)}
                        </p>
                        {renderBalanceState()}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={refreshBalance}
                        disabled={isLoadingBalance}
                        className="gap-1"
                      >
                        <RefreshCcw
                          className={cn('h-3.5 w-3.5', isLoadingBalance && 'animate-spin')}
                        />
                        Refresh
                      </Button>
                      <Button
                        type="button"
                        variant={hasEnoughBalance ? 'outline' : 'default'}
                        size="sm"
                        onClick={() => setShowTopup(true)}
                        className="gap-1"
                      >
                        <PlusCircle className="h-3.5 w-3.5" />
                        Top up
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              <Separator />

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-sm">Agents on V1 ({v1Agents.length})</Label>
                  {v1Agents.length > 0 && (
                    <button
                      type="button"
                      className="text-xs text-primary hover:underline"
                      onClick={toggleAll}
                    >
                      {selectedAgentIds.size === v1Agents.length ? 'Deselect all' : 'Select all'}
                    </button>
                  )}
                </div>

                {isLoading ? (
                  <div className="flex items-center justify-center py-8">
                    <Spinner size={20} />
                  </div>
                ) : v1Agents.length === 0 ? (
                  <div className="rounded-lg border border-dashed bg-muted/20 px-4 py-6 text-center text-sm text-muted-foreground">
                    No registered V1 agents on this source.
                  </div>
                ) : (
                  <>
                    {(() => {
                      const affectedSelected = [...selectedAgentIds].filter((id) =>
                        droppedHoldingByAgentId.has(id),
                      ).length;
                      if (affectedSelected === 0) return null;
                      return (
                        <div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-900/50 dark:bg-amber-950/20 px-3 py-2 flex items-start gap-2 mb-2">
                          <AlertTriangle className="h-3.5 w-3.5 text-amber-600 dark:text-amber-300 mt-0.5 shrink-0" />
                          <p className="text-xs text-amber-900 dark:text-amber-100 leading-snug">
                            {affectedSelected === 1
                              ? '1 selected agent uses'
                              : `${affectedSelected} selected agents use`}{' '}
                            a custom payout address that isn&apos;t set up on V2. On migrate,
                            payouts will route to the V2 selling wallet instead. Add the address as
                            a wallet on the V2 source first to preserve the original routing.
                          </p>
                        </div>
                      );
                    })()}
                    <div className="max-h-64 overflow-y-auto rounded-lg border divide-y">
                      {v1Agents.map((agent) => {
                        const result = results[agent.id];
                        const isSelected = selectedAgentIds.has(agent.id);
                        const droppedHoldingAddress = droppedHoldingByAgentId.get(agent.id);
                        return (
                          <label
                            key={agent.id}
                            className={cn(
                              'flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-muted/30 transition-colors',
                              result?.status === 'success' && 'bg-green-50 dark:bg-green-950/15',
                              result?.status === 'failed' && 'bg-red-50 dark:bg-red-950/15',
                            )}
                          >
                            <Checkbox
                              checked={isSelected}
                              disabled={isMigrating}
                              onCheckedChange={() => toggleAgent(agent.id)}
                            />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-medium truncate">{agent.name}</span>
                                <Badge variant="outline" className="text-xs shrink-0">
                                  {agent.AgentPricing.pricingType}
                                </Badge>
                                {droppedHoldingAddress && (
                                  <Badge
                                    variant="outline"
                                    className="text-xs shrink-0 border-amber-300 text-amber-700 dark:border-amber-700 dark:text-amber-300"
                                  >
                                    Payout reroutes
                                  </Badge>
                                )}
                              </div>
                              {agent.description && (
                                <p className="text-xs text-muted-foreground truncate">
                                  {agent.description}
                                </p>
                              )}
                              {droppedHoldingAddress && !result && (
                                <p className="text-xs text-amber-700 dark:text-amber-400 mt-1 flex items-start gap-1">
                                  <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
                                  <span className="truncate">
                                    Custom V1 payout {shortenAddress(droppedHoldingAddress)} not on
                                    V2 — funds will route to the selling wallet.
                                  </span>
                                </p>
                              )}
                              {result?.error && (
                                <p className="text-xs text-red-600 dark:text-red-400 mt-1 truncate">
                                  {result.error}
                                </p>
                              )}
                              {result?.status === 'success' && result.deregisterError && (
                                <p className="text-xs text-amber-700 dark:text-amber-400 mt-1 truncate">
                                  Re-registered, but V1 deregister failed: {result.deregisterError}
                                </p>
                              )}
                            </div>
                            <div className="shrink-0">
                              {result?.status === 'running' && <Spinner size={14} />}
                              {result?.status === 'success' &&
                                (result.deregisterError ? (
                                  <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-500" />
                                ) : (
                                  <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-500" />
                                ))}
                              {result?.status === 'failed' && (
                                <AlertTriangle className="h-4 w-4 text-red-600 dark:text-red-500" />
                              )}
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>

              {v1Agents.length > 0 && (
                <div className="rounded-lg border bg-muted/20 px-4 py-3 flex items-start gap-3">
                  <Checkbox
                    id="deregister-after"
                    checked={deregisterAfter}
                    disabled={isMigrating}
                    onCheckedChange={(checked) => setDeregisterAfter(checked === true)}
                    className="mt-0.5"
                  />
                  <div>
                    <Label
                      htmlFor="deregister-after"
                      className="text-sm cursor-pointer leading-tight"
                    >
                      Deregister V1 entries after successful migration
                    </Label>
                    <p className="text-xs text-muted-foreground mt-1 flex items-start gap-1">
                      <Info className="h-3 w-3 mt-0.5 shrink-0" />
                      Leave unchecked to keep V1 entries discoverable until you confirm V2 is live.
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}

          <DialogFooter className="gap-2 sm:gap-0">
            {!isDone ? (
              <>
                <Button variant="outline" onClick={handleClose} disabled={isMigrating}>
                  Cancel
                </Button>
                <Button
                  onClick={runMigration}
                  disabled={
                    isMigrating ||
                    !v2Source ||
                    !selectedV2Wallet ||
                    selectedAgentIds.size === 0 ||
                    !hasEnoughBalance
                  }
                  className="gap-2"
                >
                  {isMigrating ? (
                    <>
                      <Spinner size={14} /> Migrating…
                    </>
                  ) : (
                    <>
                      Migrate {selectedAgentIds.size > 0 ? `${selectedAgentIds.size} ` : ''}
                      agent{selectedAgentIds.size === 1 ? '' : 's'}
                      <ArrowRight className="h-4 w-4" />
                    </>
                  )}
                </Button>
              </>
            ) : (
              <Button onClick={handleClose} className="gap-2">
                Done
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {selectedV2Wallet && (
        <TransakWidget
          isOpen={showTopup}
          onClose={() => setShowTopup(false)}
          walletAddress={selectedV2Wallet.walletAddress}
          onSuccess={() => {
            void refreshBalance();
            void refetchSources();
          }}
        />
      )}
    </>
  );
}
