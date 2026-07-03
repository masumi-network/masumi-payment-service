import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { invalidateAgentQueries } from '@/lib/queries/agent-cache';
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
import { Input } from '@/components/ui/input';
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
  postRegistry,
  postRegistryDeregister,
  type PaymentSourceExtended,
  type RegistryEntry,
} from '@/lib/api/generated';
import { isV2PaymentSource } from '@/lib/payment-source-type';
import { fetchWalletBalance, usePaymentSourceWalletsAll } from '@/lib/queries/useWallets';
import { cn, shortenAddress } from '@/lib/utils';
import { extractApiErrorMessage } from '@/lib/api-error';
import { TransakWidget } from '@/components/wallets/TransakWidget';
import { agentMigrationKey, fetchAllRegistryEntries } from '@/lib/agent-migration';
import { REGISTRY_LIMITS, validateApiBaseUrl } from '@/lib/registry-validation';

const MIN_MIGRATION_BALANCE_LOVELACE = 5_000_000; // ~5 ADA buffer per agent mint

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
// `v2WalletAddresses` is the set of managed wallet addresses on the V2 source
// (null when no V2 source exists yet). Wallets are no longer embedded in the
// payment source, so callers pass the addresses fetched via /wallet/list.
function resolveV2HoldingAddress(
  agent: RegistryEntry,
  v2WalletAddresses: Set<string> | null,
): { v2HoldingAddress: string | undefined; droppedV1HoldingAddress: string | null } {
  const v1HoldingWallet =
    agent.RecipientWallet &&
    agent.RecipientWallet.walletVkey !== agent.SmartContractWallet.walletVkey
      ? agent.RecipientWallet
      : null;
  if (!v1HoldingWallet) {
    return { v2HoldingAddress: undefined, droppedV1HoldingAddress: null };
  }
  if (!v2WalletAddresses) {
    return { v2HoldingAddress: undefined, droppedV1HoldingAddress: v1HoldingWallet.walletAddress };
  }
  const onV2 = v2WalletAddresses.has(v1HoldingWallet.walletAddress);
  return onV2
    ? { v2HoldingAddress: v1HoldingWallet.walletAddress, droppedV1HoldingAddress: null }
    : { v2HoldingAddress: undefined, droppedV1HoldingAddress: v1HoldingWallet.walletAddress };
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
  // Every V2 source on the network. Used to detect already-migrated agents
  // across ALL V2 contracts (see v2AgentsQuery). The migration *target* is a
  // single source (v2Source) — re-mints land there and wallet/payout checks are
  // scoped to it — but "already migrated?" must consider every V2 source or the
  // dialog would re-offer an agent already minted on a different V2 contract.
  const v2Sources = useMemo(
    () => currentNetworkSources.filter(isV2PaymentSource),
    [currentNetworkSources],
  );
  const v2Source = useMemo<PaymentSourceExtended | undefined>(() => v2Sources[0], [v2Sources]);
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

  // V2 target wallets come from the dedicated /wallet/list endpoint (scoped to
  // the V2 source), not from the payment-source response.
  const { wallets: v2Wallets, isLoading: isLoadingV2Wallets } = usePaymentSourceWalletsAll(
    v2Source?.id ?? null,
    open && !!v2Source,
  );
  // True once the V2 wallet set is known. Until then we must not infer that a
  // V1 payout address is "missing on V2" — the set is just not loaded yet.
  const v2WalletsReady = !v2Source || !isLoadingV2Wallets;
  const v2SellingWallets = useMemo(
    () => v2Wallets.filter((wallet) => wallet.type === 'Selling'),
    [v2Wallets],
  );
  const v2WalletAddresses = useMemo(
    () => (v2Source ? new Set(v2Wallets.map((wallet) => wallet.walletAddress)) : null),
    [v2Source, v2Wallets],
  );
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

  // Agents already registered on ANY V2 source on this network. Migration re-mints
  // with the same name + description, so we match on those (agentMigrationKey) to
  // hide already-migrated agents from the list. Union every V2 source — not just
  // the migration target — so an agent already minted on a different V2 contract
  // isn't re-offered for a duplicate re-mint.
  const v2Addresses = useMemo(() => v2Sources.map((s) => s.smartContractAddress), [v2Sources]);
  const v2AgentsQuery = useQuery<RegistryEntry[]>({
    queryKey: ['migrate-v2-agents', network, [...v2Addresses].sort()],
    queryFn: async () => {
      const lists = await Promise.all(
        v2Addresses.map((smartContractAddress) =>
          fetchAllRegistryEntries({ apiClient, network, smartContractAddress }),
        ),
      );
      return lists.flat();
    },
    enabled: open && v2Addresses.length > 0,
    staleTime: 15_000,
  });
  const v2AgentKeys = useMemo(
    () => new Set((v2AgentsQuery.data ?? []).map(agentMigrationKey)),
    [v2AgentsQuery.data],
  );

  const allV1Agents = useMemo(() => v1AgentsQuery.data ?? [], [v1AgentsQuery.data]);
  const v1Agents = useMemo(
    () => allV1Agents.filter((agent) => !v2AgentKeys.has(agentMigrationKey(agent))),
    [allV1Agents, v2AgentKeys],
  );

  // Agents whose V1 holding wallet has no V2 counterpart — funds re-routed to
  // the V2 selling wallet on migrate. Keyed by agent.id so per-row render and
  // the selected-count summary share one computation.
  const droppedHoldingByAgentId = useMemo(() => {
    const map = new Map<string, string>();
    // Don't flag reroutes until the V2 wallet set has loaded, otherwise every
    // custom payout looks "missing on V2" during the fetch.
    if (!v2WalletsReady) return map;
    for (const a of v1Agents) {
      const { droppedV1HoldingAddress } = resolveV2HoldingAddress(a, v2WalletAddresses);
      if (droppedV1HoldingAddress) map.set(a.id, droppedV1HoldingAddress);
    }
    return map;
  }, [v1Agents, v2WalletAddresses, v2WalletsReady]);

  const [selectedAgentIds, setSelectedAgentIds] = useState<Set<string>>(new Set());
  // Optional per-agent API base URL override. The V2 re-registration copies the V1
  // apiBaseUrl by default; editing it here lets the operator point the new entry at an
  // updated route during migration. Keyed by agent id; absent = keep the original.
  const [urlOverrides, setUrlOverrides] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!open) {
      setUrlOverrides({});
      return;
    }
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

  // The apiBaseUrl actually submitted for an agent: the trimmed override when
  // present, else the trimmed inherited V1 value. Single source of truth shared
  // by the validation gate and buildRegistryBody — they MUST agree byte-for-byte,
  // or a padded V1 URL passes the (trimming) gate yet fails postRegistry's
  // untrimmed max(250)/url() checks after the UI looked valid.
  const resolveApiBaseUrl = useCallback(
    (agent: RegistryEntry) => urlOverrides[agent.id]?.trim() || agent.apiBaseUrl?.trim() || '',
    [urlOverrides],
  );

  // Validate the apiBaseUrl that will actually be submitted for each selected
  // agent (the override when present, else the inherited V1 value). Mirrors the
  // registration form's URL rules so an invalid override is caught here instead
  // of only failing when postRegistry runs. Keyed by agent id; absent = valid.
  const urlOverrideErrors = useMemo(() => {
    const errors = new Map<string, string>();
    for (const agent of v1Agents) {
      if (!selectedAgentIds.has(agent.id)) continue;
      const error = validateApiBaseUrl(resolveApiBaseUrl(agent));
      if (error) errors.set(agent.id, error);
    }
    return errors;
  }, [v1Agents, selectedAgentIds, resolveApiBaseUrl]);
  const hasInvalidUrlOverride = urlOverrideErrors.size > 0;

  // Migration execution
  const [results, setResults] = useState<Record<string, MigrationResult>>({});
  const [isMigrating, setIsMigrating] = useState(false);
  const [deregisterAfter, setDeregisterAfter] = useState(false);
  const [isDone, setIsDone] = useState(false);
  // Two-step Confirm before kicking off the multi-tx batch. Each successful
  // V2 re-mint produces a new on-chain agentIdentifier and spends ~5 ADA in
  // fees; a mis-click on "Migrate N agents" must not silently start the run.
  const [confirmPending, setConfirmPending] = useState(false);
  // User-driven abort flag; the loop polls this between agents and bails
  // gracefully (the in-flight agent's request still completes, but no
  // further agents are processed). Ref because the value must be read
  // inside the async loop's closure without triggering re-renders.
  const cancelRef = useRef(false);

  // Synchronous re-entry guard for runMigration. `setIsMigrating(true)` is
  // async, so a double-click on the Confirm button fires runMigration twice
  // within the same render frame — both invocations pass the `success`
  // idempotency filter (the first hasn't written results yet) and BOTH call
  // postRegistry, minting two on-chain agents (~5 ADA wasted + a duplicate
  // registration). A ref flips synchronously on the first call, so the second
  // returns immediately. `disabled={isMigrating}` on the button is additional
  // (post-render) defense-in-depth.
  const isRunningRef = useRef(false);

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
      // Refresh the V2 set too, so reopening the dialog re-derives which agents are
      // already migrated from fresh data instead of re-offering just-migrated ones.
      queryClient.invalidateQueries({ queryKey: ['migrate-v2-agents'] });
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

  // Constructs the V2 mint payload from a V1 RegistryEntry.
  //
  // INTENTIONAL OMISSION: `agent.supportedPaymentSources` is NOT forwarded
  // to the V2 entry. V1 supportedPaymentSources advertise compatibility
  // with V1 contracts; carrying them onto a V2 mint would publish a V2
  // agent that claims V1 contract support, which is incorrect — V2 agents
  // must only advertise V2-contract compatibility. The V2 registry's
  // default behavior (advertise the active V2 payment source if no
  // explicit list is supplied) is the right shape here. Do NOT add a
  // `supportedPaymentSources:` line below without re-evaluating the
  // V1/V2 contract-compatibility model.
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
      // Preserve the real V1 author name verbatim — including empty. The
      // backend accepts an empty author name (Author.name is `z.string()` with
      // no min), so defaulting an empty value to a placeholder would fabricate
      // on-chain authorship the operator never set. Empty in → empty out.
    } = { name: agent.Author.name };
    if (agent.Author.contactEmail) author.contactEmail = agent.Author.contactEmail;
    if (agent.Author.contactOther) author.contactOther = agent.Author.contactOther;
    if (agent.Author.organization) author.organization = agent.Author.organization;

    // Preserve V1's distinct holding wallet on V2 only when the same address
    // exists as a managed wallet on the V2 source — otherwise the backend
    // would reject the unknown address. The dropped case is also surfaced
    // per-row in the UI so the user can opt out before migrating instead of
    // silently inheriting the V2 selling wallet as their payout target.
    const { v2HoldingAddress } = resolveV2HoldingAddress(agent, v2WalletAddresses);

    return {
      network,
      sellingWalletVkey: walletVkey,
      recipientWalletAddress: v2HoldingAddress,
      sendFundingLovelace:
        v2HoldingAddress && agent.sendFundingLovelace ? agent.sendFundingLovelace : undefined,
      name: agent.name,
      // Preserve the real V1 description, empty included. The backend accepts
      // an empty description; substituting the agent name would fabricate
      // copy the operator never wrote.
      description: agent.description ?? '',
      // Use the operator's edited URL when provided, otherwise keep the V1 value.
      // Trimmed (via resolveApiBaseUrl) to match exactly what the gate validated.
      apiBaseUrl: resolveApiBaseUrl(agent),
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

  const startMigration = () => {
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
    if (hasInvalidUrlOverride) {
      toast.error('Fix the invalid API base URL before migrating');
      return;
    }
    // Two-step Confirm: first click flips into the confirm preview; second
    // click on "Confirm migration" triggers `runMigration`. Prevents
    // accidental kickoff of an irreversible multi-tx batch on a single
    // mis-click. (`runMigration` itself re-checks the gates.)
    setConfirmPending(true);
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
    if (hasInvalidUrlOverride) {
      toast.error('Fix the invalid API base URL before migrating');
      return;
    }

    // Synchronous double-submit guard (see isRunningRef declaration). Must run
    // before any await / state set so a same-frame second click is rejected.
    if (isRunningRef.current) {
      return;
    }
    isRunningRef.current = true;

    setConfirmPending(false);
    cancelRef.current = false;
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

    // Re-run idempotency: preserve any prior `success` results so a re-run
    // (e.g. after a partial failure) does not re-mint already-migrated
    // agents. Each successful re-mint creates a fresh on-chain
    // agentIdentifier; reprocessing duplicates them and wastes ~5 ADA in
    // fees per duplicate. Read the latest results snapshot via setResults's
    // updater so this works even if `runMigration` is called twice in
    // rapid succession.
    let priorResults: Record<string, MigrationResult> = {};
    setResults((prev) => {
      priorResults = prev;
      const next: Record<string, MigrationResult> = {};
      for (const agent of validAgents) {
        next[agent.id] =
          prev[agent.id]?.status === 'success'
            ? prev[agent.id]
            : { agentId: agent.id, status: 'pending' };
      }
      return next;
    });

    let successCount = 0;
    let skippedAlreadySuccessfulCount = 0;

    for (const agent of validAgents) {
      if (!mountedRef.current) return;
      if (cancelRef.current) {
        // User aborted between agents. The agents still showing 'pending'
        // are left as-is; the user can re-open Migrate and continue from
        // where it left off (the prior-results preservation above will skip
        // anything that already succeeded).
        break;
      }
      if (priorResults[agent.id]?.status === 'success') {
        // Already migrated in a prior run; skip without resubmitting.
        skippedAlreadySuccessfulCount += 1;
        continue;
      }

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
                  // V1 source — explicit address required because the
                  // default fallback resolves to V1 anyway but is
                  // unambiguous when threaded through.
                  smartContractAddress: selectedV1Source!.smartContractAddress,
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

    isRunningRef.current = false;
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
      invalidateAgentQueries(queryClient);
      queryClient.invalidateQueries({ queryKey: ['payment-sources-all'] });
      // Each successful re-mint debits ~5 ADA from the V2 selling wallet.
      // The wallet-balance / transactions caches would otherwise show
      // stale balances until the next ~25s refetch tick, surprising the
      // operator who just kicked off a multi-agent batch.
      queryClient.invalidateQueries({ queryKey: ['wallets'] });
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
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

  const isLoading =
    isLoadingSources ||
    (!!selectedV1Source && v1AgentsQuery.isLoading) ||
    // Wait for the V2 set too, so the list isn't briefly shown unfiltered (with
    // already-migrated agents) before the V2 query resolves.
    (!!v2Source && v2AgentsQuery.isLoading);

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => !o && !isMigrating && handleClose()}>
        {/* The base DialogContent is a grid whose items default to min-width:auto, so a
            single wide child (long address, a non-wrapping line) would stretch the whole
            dialog past its max width — clipping the right edge and pushing the footer's
            primary button off-screen. `[&>*]:min-w-0` lets each grid row shrink/wrap, and
            overflow-x-hidden clips any residual so the action button stays in the box.
            `pb-0` removes the base bottom padding: a `sticky bottom-0` child anchors that
            padding's height ABOVE the real bottom edge, which would leave a gap below the
            footer where scrolled-out content peeks through. The footer supplies its own
            bottom spacing via `py-4`. */}
        <DialogContent
          size="lg"
          className="overflow-y-auto overflow-x-hidden max-h-[90vh] pb-0 [&>*]:min-w-0"
        >
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
                  <Label className="text-sm">Not yet on V2 ({v1Agents.length})</Label>
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
                    {allV1Agents.length > 0
                      ? 'All V1 agents on this source are already on V2 — nothing left to migrate.'
                      : 'No registered V1 agents on this source.'}
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
                              {isSelected && !result && (
                                <div className="mt-1.5">
                                  {(() => {
                                    const urlError = urlOverrideErrors.get(agent.id);
                                    return (
                                      <>
                                        <Input
                                          value={urlOverrides[agent.id] ?? agent.apiBaseUrl ?? ''}
                                          onChange={(e) =>
                                            setUrlOverrides((prev) => ({
                                              ...prev,
                                              [agent.id]: e.target.value,
                                            }))
                                          }
                                          onClick={(e) => e.stopPropagation()}
                                          onKeyDown={(e) => e.stopPropagation()}
                                          disabled={isMigrating}
                                          maxLength={REGISTRY_LIMITS.apiBaseUrl}
                                          placeholder="API base URL"
                                          aria-label={`API base URL for ${agent.name}`}
                                          aria-invalid={urlError ? true : undefined}
                                          className={cn(
                                            'h-7 font-mono text-xs',
                                            urlError &&
                                              'border-destructive focus-visible:ring-destructive',
                                          )}
                                        />
                                        {urlError ? (
                                          <p className="mt-0.5 text-[10px] text-red-600 dark:text-red-400">
                                            {urlError}
                                          </p>
                                        ) : (
                                          <p className="mt-0.5 text-[10px] text-muted-foreground">
                                            Edit to point this agent at a new route on V2; leave
                                            as-is to keep the V1 URL.
                                          </p>
                                        )}
                                      </>
                                    );
                                  })()}
                                </div>
                              )}
                              {droppedHoldingAddress && !result && (
                                <p className="text-xs text-amber-700 dark:text-amber-400 mt-1 flex items-start gap-1">
                                  <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
                                  <span className="truncate" title={droppedHoldingAddress}>
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
                                <AlertTriangle className="h-4 w-4 text-red-600 dark:text-destructive" />
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

          {confirmPending && !isMigrating && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm space-y-1">
              <p className="font-medium">Confirm before migrating</p>
              <p className="text-xs text-muted-foreground">
                This will mint {selectedAgentIds.size} new on-chain agent registration
                {selectedAgentIds.size === 1 ? '' : 's'} on V2 and spend ~
                {(requiredBalance / 1_000_000).toFixed(2)} ADA in fees.
                {deregisterAfter &&
                  ' Selected V1 entries will be deregistered after each successful mint.'}{' '}
                This action cannot be undone on chain. Already-successful agents from a previous run
                will be skipped.
              </p>
            </div>
          )}

          {isDone && Object.values(results).some((r) => r.status === 'success') && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm dark:border-amber-900/50 dark:bg-amber-950/20">
              <p className="font-medium text-amber-950 dark:text-amber-100">
                Update your agents for the old routes
              </p>
              <p className="mt-1 text-amber-900/80 dark:text-amber-100/80">
                The migrated agents are re-registered on V2. Update each agent&apos;s own
                configuration (and anything still calling the old V1 routes) to use the V2 payment
                source. Each agent&apos;s new V2 identifier appears on the AI Agents page once
                minting confirms.
              </p>
            </div>
          )}

          <DialogFooter className="gap-2 sm:gap-0 sticky bottom-0 -mx-6 border-t bg-background px-6 py-4">
            {!isDone ? (
              <>
                {/* Cancel-during-run: flips the `cancelRef` flag the loop
                    polls between agents. The currently in-flight agent's
                    request still completes; subsequent agents are skipped.
                    Disabled when not migrating — close the dialog via the
                    Cancel button to the left instead. */}
                {isMigrating ? (
                  <Button
                    variant="outline"
                    onClick={() => {
                      cancelRef.current = true;
                      toast.info('Stopping after current agent completes…');
                    }}
                  >
                    Stop migration
                  </Button>
                ) : confirmPending ? (
                  <Button variant="outline" onClick={() => setConfirmPending(false)}>
                    Back
                  </Button>
                ) : (
                  <Button variant="outline" onClick={handleClose}>
                    Cancel
                  </Button>
                )}
                {confirmPending ? (
                  <Button
                    onClick={runMigration}
                    disabled={isMigrating}
                    className="gap-2"
                    variant="destructive"
                  >
                    Confirm migration of {selectedAgentIds.size} agent
                    {selectedAgentIds.size === 1 ? '' : 's'}
                    <ArrowRight className="h-4 w-4" />
                  </Button>
                ) : (
                  <Button
                    onClick={startMigration}
                    disabled={
                      isMigrating ||
                      !v2Source ||
                      !selectedV2Wallet ||
                      selectedAgentIds.size === 0 ||
                      !hasEnoughBalance ||
                      hasInvalidUrlOverride
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
                )}
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
