import { Button } from '@/components/ui/button';
import { MainLayout } from '@/components/layout/MainLayout';
import { Plus, ArrowUpRight, ExternalLink, Trash2, Unlink } from 'lucide-react';
import { RefreshButton } from '@/components/RefreshButton';
import { useState, useCallback, useMemo, useEffect, useRef } from 'react';

import { useRouter } from 'next/router';
import { RegisterAIAgentDialog } from '@/components/ai-agents/RegisterAIAgentDialog';
import { Badge } from '@/components/ui/badge';

import { cn, formatAssetAmount, shortenAddress, getExplorerUrl } from '@/lib/utils';
import { useAppContext } from '@/lib/contexts/AppContext';
import { deleteRegistry, RegistryEntry, postRegistryDeregister } from '@/lib/api/generated';
import { agentHasX402Options } from '@/components/ai-agents/AgentX402Options';
import { agentHasVerifications } from '@/components/ai-agents/AgentVerifications';
import { toast } from 'react-toastify';
import { useApiMutation } from '@/lib/hooks/useApiMutation';
import Head from 'next/head';
import { AIAgentTableSkeleton } from '@/components/skeletons/AIAgentTableSkeleton';
import { HorizontalScrollArea } from '@/components/ui/horizontal-scroll-area';
import {
  tableActionsCellCompactClass,
  tableActionsCellCompactSelectedClass,
  tableActionsHeadCompactClass,
  tableActionsInnerClass,
} from '@/components/ui/table-actions-column';
import { AIAgentRowActionsMenu } from '@/components/ai-agents/AIAgentRowActionsMenu';
import { Separator } from '@/components/ui/separator';
import { Spinner } from '@/components/ui/spinner';
import { useQueryClient } from '@tanstack/react-query';
import { useContextAgents, type AgentRelation } from '@/lib/queries/useContextAgents';
import { invalidateAgentQueries, resetAgentQueries } from '@/lib/queries/agent-cache';
import { rowActivation } from '@/lib/a11y';
import { isDbDeletableAgentState, isDeregisterableAgentState } from '@/lib/registry-states';
import { BulkActionBar } from '@/components/ui/bulk-action-bar';
import {
  TableSelectAllCheckbox,
  TableSelectRowCheckbox,
} from '@/components/ui/table-select-checkbox';
import {
  BULK_ACTION_MAX_ITEMS,
  runBulkSequential,
  useTableSelection,
} from '@/lib/hooks/useTableSelection';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { FaRegClock } from 'react-icons/fa';
import { Tabs } from '@/components/ui/tabs';
import { Pagination } from '@/components/ui/pagination';
import { VerifyAndPublishAgentDialog } from '@/components/ai-agents/VerifyAndPublishAgentDialog';
import { WalletDetailsDialog, WalletWithBalance } from '@/components/wallets/WalletDetailsDialog';
import { CopyButton } from '@/components/ui/copy-button';
import { usePaymentSourceExtendedAll } from '@/lib/hooks/usePaymentSourceExtendedAll';
import { AnimatedPage } from '@/components/ui/animated-page';
import { EmptyState } from '@/components/ui/empty-state';
import { SearchInput } from '@/components/ui/search-input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useDebouncedValue } from '@/lib/hooks/useDebouncedValue';
import { filterAgentsClientSide } from '@/lib/client-search/agent-search';
import { useRegistryEntryByAgentIdentifier } from '@/lib/queries/useRegistryEntryByAgentIdentifier';
import { useAgentDetailsDialog } from '@/lib/contexts/AgentDetailsDialogContext';
import { lookupWalletByVkey } from '@/lib/wallet-lookup';
import { isV2PaymentSource } from '@/lib/payment-source-type';
import { canEditAgentMetadata } from '@/lib/can-edit-agent-metadata';
import { MigrateAgentsDialog } from '@/components/ai-agents/MigrateAgentsDialog';
import {
  parseAgentStatus,
  getAgentStatusBadgeVariant,
  getAgentStatusHelperText,
  getAgentIdentifierPlaceholder,
} from '@/lib/agent-status';
import { AGENT_TYPE_LABELS, getAgentTypeLabel } from '@/lib/agent-type';
import { formatDate } from '@/lib/format-date';
import { getPrimaryCardanoPricing } from '@/lib/registry-pricing';
type AIAgent = RegistryEntry & { relation?: AgentRelation };

function RelationBadge({ relation }: { relation?: AgentRelation }) {
  if (relation === 'payment') {
    return (
      <Badge
        variant="outline"
        className="w-fit border-indigo-300 bg-indigo-50 text-[10px] text-indigo-700 dark:border-indigo-900/60 dark:bg-indigo-950/30 dark:text-indigo-300"
      >
        Registered elsewhere
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="w-fit text-[10px]">
      Registered here
    </Badge>
  );
}

type AgentWalletRowProps = {
  label: string;
  address: string;
  walletVkey: string;
  onWalletClick: (walletVkey: string) => void;
  /** Wider preview when minting and holding share one address (single-column layout). */
  variant?: 'split' | 'combined';
};

function AgentWalletRow({
  label,
  address,
  walletVkey,
  onWalletClick,
  variant = 'split',
}: AgentWalletRowProps) {
  const previewChars = variant === 'combined' ? 10 : 4;

  return (
    <div className={cn('min-w-0 space-y-1', variant === 'split' && 'flex-1')}>
      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <div className="flex min-w-0 items-center gap-1.5">
        <button
          type="button"
          className={cn(
            'min-w-0 text-left font-mono text-xs text-muted-foreground hover:text-primary',
            variant === 'combined' ? 'max-w-[14rem] truncate' : 'truncate',
          )}
          title={address}
          onClick={(event) => {
            event.stopPropagation();
            onWalletClick(walletVkey);
          }}
        >
          {shortenAddress(address, previewChars)}
        </button>
        <CopyButton value={address} />
      </div>
    </div>
  );
}

const getHoldingWallet = (agent: AIAgent) => agent.RecipientWallet ?? agent.SmartContractWallet;

const usesCombinedWallet = (agent: AIAgent) =>
  getHoldingWallet(agent).walletVkey === agent.SmartContractWallet.walletVkey;

function isBulkDeletableAgent(agent: AIAgent, canAdmin: boolean): boolean {
  return canAdmin && agent.relation !== 'payment' && isDbDeletableAgentState(agent.state);
}

function isBulkDeregisterableAgent(agent: AIAgent, canPay: boolean): boolean {
  return (
    canPay &&
    agent.relation !== 'payment' &&
    isDeregisterableAgentState(agent.state) &&
    Boolean(agent.agentIdentifier?.trim())
  );
}

export default function AIAgentsPage() {
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState('');
  const [isRegisterDialogOpen, setIsRegisterDialogOpen] = useState(false);
  const [isMigrateDialogOpen, setIsMigrateDialogOpen] = useState(false);
  const debouncedSearchQuery = useDebouncedValue(searchQuery);

  const [activeTab, setActiveTab] = useState('All');
  const [typeFilter, setTypeFilter] = useState<'All' | 'Standard' | 'OpenApi' | 'X402'>('All');

  const filterStatus = useMemo(() => {
    if (activeTab === 'All') return undefined;
    return activeTab as 'Registered' | 'Deregistered' | 'Pending' | 'Failed';
  }, [activeTab]);

  // Rail-aware agent list: shows agents registered on the active context plus those
  // registered elsewhere that accept payment on it (Cardano source, or EVM chains over
  // x402). Results load one cursor page at a time so navigation stays quick.
  const {
    agents,
    truncated,
    hasMore: hasMoreAgents,
    isLoading,
    isFetching: isFetchingAgents,
    isFetchingNextPage,
    isPlaceholderData,
    loadMore,
  } = useContextAgents({
    filterStatus,
    searchQuery: debouncedSearchQuery || undefined,
  });

  const queryClient = useQueryClient();
  const { openAgentDetails, closeAgentDetails } = useAgentDetailsDialog();

  // Passive refresh (the refresh button): keep the current rows on screen and
  // refetch in the background.
  const refetchAll = useCallback(() => {
    // Invalidate the full ['context-agents'] and ['agents'] prefixes so EVERY status-tab /
    // search variant refetches (not just the active query), and the dashboard / testing
    // dialogs reflect the mutation too. Also refresh wallet balances (fees/settlement).
    invalidateAgentQueries(queryClient);
    void queryClient.invalidateQueries({ queryKey: ['wallets'] });
  }, [queryClient]);

  // Post-mutation refresh (register / update / deregister / delete): the current
  // rows are now stale, so clear the agent lists to their skeleton while the
  // fresh data loads. Wallet balances stay put (invalidate, not reset).
  const refetchAfterMutation = useCallback(() => {
    resetAgentQueries(queryClient);
    void queryClient.invalidateQueries({ queryKey: ['wallets'] });
  }, [queryClient]);

  // True whenever server-authoritative results haven't arrived yet:
  // either the debounce hasn't fired, or the server fetch is still in-flight with stale data.
  const isSearchPending =
    searchQuery !== debouncedSearchQuery || (isFetchingAgents && isPlaceholderData);

  // Client-side filter for instant feedback while server results are pending.
  // Mirrors the backend Prisma OR filter in src/routes/api/registry/index.ts
  // to avoid items appearing/disappearing when the server responds.
  const displayAgents = useMemo(() => {
    // Type filter is a plain client-side facet (not a separate tab): absent
    // type is Standard, matching the on-chain default.
    const byType = (list: typeof agents) =>
      typeFilter === 'All'
        ? list
        : list.filter((agent) => (agent.type ?? 'Standard') === typeFilter);

    const query = searchQuery.toLowerCase().trim();
    if (!query || (query === debouncedSearchQuery.toLowerCase().trim() && !isPlaceholderData))
      return byType(agents);

    return byType(filterAgentsClientSide(agents, searchQuery));
  }, [agents, searchQuery, debouncedSearchQuery, isPlaceholderData, typeFilter]);

  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isBulkDeleteConfirmOpen, setIsBulkDeleteConfirmOpen] = useState(false);
  const [isBulkDeregisterConfirmOpen, setIsBulkDeregisterConfirmOpen] = useState(false);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);
  const [isBulkDeregistering, setIsBulkDeregistering] = useState(false);
  const [selectedAgentToDelete, setSelectedAgentToDelete] = useState<AIAgent | null>(null);
  const deleteAgentMutation = useApiMutation({
    mutationFn: (body: { id: string }) => deleteRegistry({ client: apiClient, body }),
    errorMessage: 'Failed to delete AI agent',
  });
  const deregisterAgentMutation = useApiMutation({
    mutationFn: (body: {
      agentIdentifier: string;
      network: typeof network;
      smartContractAddress: string;
    }) => postRegistryDeregister({ client: apiClient, body }),
    errorMessage: 'Failed to deregister AI agent',
  });
  const isDeleting = deleteAgentMutation.isPending || deregisterAgentMutation.isPending;
  // Synchronous in-flight guard for delete/deregister. `setIsDeleting(true)` is
  // async, so a fast double-click on Confirm fires `handleDeleteConfirm` twice
  // before the button disables — sending two DELETEs for the same id. The second
  // then races the first (the backend reports the row already gone). A ref flips
  // synchronously on the first call so the duplicate is rejected immediately;
  // `isDeleting` on the button is post-render defence-in-depth.
  const isDeletingRef = useRef(false);
  const [selectedAgentToUpdate, setSelectedAgentToUpdate] = useState<AIAgent | null>(null);
  // Snapshot the agent's payment-source smart-contract address AT CLICK TIME.
  // The agent list is already filtered to `selectedPaymentSource`, so at the
  // moment of the click that source IS the agent's source. We must not read the
  // live `selectedPaymentSource` later in the dialog prop: the update dialog
  // stays mounted, and if the global source selector changes while it is open,
  // the address would drift to a DIFFERENT source than the agent belongs to and
  // the update would target the wrong contract.
  const [updateAgentSmartContractAddress, setUpdateAgentSmartContractAddress] = useState<
    string | null
  >(null);
  const {
    apiClient,
    network,
    selectedPaymentSourceId,
    selectedPaymentSource,
    activeRail,
    capabilities,
  } = useAppContext();
  const { paymentSources } = usePaymentSourceExtendedAll();

  const showBulkSelection =
    activeRail === 'cardano' && (capabilities.canAdmin || capabilities.canPay);

  const visibleRowIds = useMemo(() => displayAgents.map((agent) => agent.id), [displayAgents]);

  const agentsById = useMemo(
    () => new Map(displayAgents.map((agent) => [agent.id, agent])),
    [displayAgents],
  );

  const bulkDeletableIds = useMemo(
    () =>
      displayAgents
        .filter((agent) => isBulkDeletableAgent(agent, capabilities.canAdmin))
        .map((agent) => agent.id),
    [displayAgents, capabilities.canAdmin],
  );

  const bulkDeregisterableIds = useMemo(
    () =>
      displayAgents
        .filter((agent) => isBulkDeregisterableAgent(agent, capabilities.canPay))
        .map((agent) => agent.id),
    [displayAgents, capabilities.canPay],
  );

  const {
    selectedCount,
    clearSelection,
    allSelected,
    someSelected,
    toggleAll,
    toggleRow,
    isSelected,
    setSelectionToIds,
    selectedIds,
  } = useTableSelection(visibleRowIds);

  const bulkDeletableSelectedIds = useMemo(
    () => [...selectedIds].filter((id) => bulkDeletableIds.includes(id)),
    [selectedIds, bulkDeletableIds],
  );

  const bulkDeregisterableSelectedIds = useMemo(
    () => [...selectedIds].filter((id) => bulkDeregisterableIds.includes(id)),
    [selectedIds, bulkDeregisterableIds],
  );

  const isBulkActionBusy = isBulkDeleting || isBulkDeregistering;

  const tableColumnCount = showBulkSelection ? 10 : 9;

  const currentNetworkPaymentSources = useMemo(
    () => paymentSources.filter((paymentSource) => paymentSource.network === network),
    [paymentSources, network],
  );
  const hasV2Source = useMemo(
    () => currentNetworkPaymentSources.some(isV2PaymentSource),
    [currentNetworkPaymentSources],
  );
  // "Migrate to V2" only applies while viewing a legacy (V1) source — it migrates
  // the listed agents onto the V2 contract. Hide it when the selected source is
  // already V2 (nothing to migrate from here) or when no V2 target exists to
  // migrate into. The dashboard also shows a lightweight V1 hint without scanning
  // agents until the migration dialog opens.
  const isViewingLegacySource =
    !!selectedPaymentSource && !isV2PaymentSource(selectedPaymentSource);
  const canMigrate = hasV2Source && isViewingLegacySource;
  const [selectedAgentForVerification, setSelectedAgentForVerification] = useState<AIAgent | null>(
    null,
  );
  const [selectedWalletForDetails, setSelectedWalletForDetails] =
    useState<WalletWithBalance | null>(null);

  const agentIdentifierFromQuery =
    router.isReady && typeof router.query.agentIdentifier === 'string'
      ? router.query.agentIdentifier
      : undefined;

  const registryLookupSmartContractAddress = selectedPaymentSource?.smartContractAddress ?? null;

  const {
    data: deepLinkedAgent,
    isFetching: deepLinkFetching,
    isFetched: deepLinkFetched,
  } = useRegistryEntryByAgentIdentifier({
    agentIdentifier: agentIdentifierFromQuery,
    smartContractAddress: registryLookupSmartContractAddress,
    enabled: Boolean(agentIdentifierFromQuery && registryLookupSmartContractAddress),
  });

  const deepLinkHandledRef = useRef<string | null>(null);

  useEffect(() => {
    if (!agentIdentifierFromQuery) {
      deepLinkHandledRef.current = null;
      return;
    }
    if (!registryLookupSmartContractAddress || !deepLinkFetched || deepLinkFetching) return;

    if (deepLinkHandledRef.current === agentIdentifierFromQuery) return;
    deepLinkHandledRef.current = agentIdentifierFromQuery;

    if (deepLinkedAgent) {
      openAgentDetails(deepLinkedAgent, { initialTab: 'Details' });
    } else {
      toast.error('Agent not found in registry for this payment source.');
    }

    const nextQuery = { ...router.query };
    delete nextQuery.agentIdentifier;
    void router.replace({ pathname: '/ai-agents', query: nextQuery }, undefined, { shallow: true });
  }, [
    agentIdentifierFromQuery,
    registryLookupSmartContractAddress,
    deepLinkedAgent,
    deepLinkFetched,
    deepLinkFetching,
    router,
    openAgentDetails,
  ]);

  const tabs = [
    { name: 'All', count: null },
    { name: 'Registered', count: null },
    { name: 'Deregistered', count: null },
    { name: 'Pending', count: null },
    { name: 'Failed', count: null },
  ];

  // Open the register dialog when the ?action=register_agent deep link arrives,
  // then strip the param so the same quick action can fire again while already
  // on this page. Registration is Cardano-only, so the deep link must not pop
  // the dialog while the x402 rail is active (the button is hidden there too).
  useEffect(() => {
    if (router.query.action !== 'register_agent') return;
    // Strip the action param regardless of the active rail. If we only stripped
    // it on the cardano rail (as before), arriving on the x402 rail would leave
    // ?action=register_agent lingering in the URL and then pop the dialog on a
    // later switch to the cardano rail. Preserve any other params (e.g. the
    // agentIdentifier deep link).
    const { action: _action, ...rest } = router.query;
    void router.replace({ pathname: '/ai-agents', query: rest }, undefined, { shallow: true });
    // Registration is Cardano-only, so only actually open the dialog there. It is
    // also pay-authenticated: without the canPay gate a read-only key reaching this
    // deep link (e.g. from the dashboard welcome banner) gets the full form and only
    // finds out on submit, when POST /registry 401s.
    if (activeRail === 'cardano' && capabilities.canPay) {
      queueMicrotask(() => setIsRegisterDialogOpen(true));
    }
  }, [router.query.action, activeRail, router, capabilities.canPay]);

  const shouldOpenRegisterDialog =
    activeRail === 'cardano' && capabilities.canPay && isRegisterDialogOpen;

  const handleDeleteClick = (agent: AIAgent) => {
    setSelectedAgentToDelete(agent);
    setIsDeleteDialogOpen(true);
  };

  const handleUpdateClick = (agent: AIAgent) => {
    if (!selectedPaymentSource?.smartContractAddress) {
      toast.error('Cannot update agent: Missing payment source');
      return;
    }
    if (!isV2PaymentSource(selectedPaymentSource)) {
      // The Update button is hidden in the row UI for non-V2 sources, but
      // guard here too in case the selected source flipped between click
      // and handler dispatch.
      toast.error('Update is only supported for Web3CardanoV2 payment sources');
      return;
    }
    // Freeze the source address now — the list is filtered to this source, so
    // it is the agent's source. Reading it later (render time) risks global
    // selector drift targeting the wrong contract.
    setUpdateAgentSmartContractAddress(selectedPaymentSource.smartContractAddress);
    setSelectedAgentToUpdate(agent);
  };

  const handleDeleteConfirm = async () => {
    if (isDeletingRef.current) return;
    isDeletingRef.current = true;
    try {
      await runDeleteConfirm();
    } finally {
      isDeletingRef.current = false;
    }
  };

  const runDeleteConfirm = async () => {
    if (
      selectedAgentToDelete?.state === 'RegistrationFailed' ||
      selectedAgentToDelete?.state === 'DeregistrationConfirmed'
    ) {
      const response = await deleteAgentMutation
        .mutateAsync({ id: selectedAgentToDelete.id })
        .catch((error: unknown) => {
          console.error('Error deleting agent:', error);
          return null;
        });
      if (response) {
        toast.success('AI agent deleted successfully');
        setIsDeleteDialogOpen(false);
        setSelectedAgentToDelete(null);
        refetchAfterMutation();
      }
    } else if (isDeregisterableAgentState(selectedAgentToDelete?.state)) {
      if (!selectedAgentToDelete?.agentIdentifier) {
        toast.error('Cannot deregister agent: Missing identifier');
        return;
      }
      if (!selectedPaymentSource?.smartContractAddress) {
        toast.error('Cannot deregister agent: Missing payment source');
        return;
      }
      const response = await deregisterAgentMutation
        .mutateAsync({
          agentIdentifier: selectedAgentToDelete.agentIdentifier!,
          network: network,
          smartContractAddress: selectedPaymentSource.smartContractAddress,
        })
        .catch((error: unknown) => {
          console.error('Error deregistering agent:', error);
          return null;
        });
      if (response) {
        toast.success('AI agent deregistered successfully');
        setIsDeleteDialogOpen(false);
        setSelectedAgentToDelete(null);
        refetchAfterMutation();
      }
    } else {
      toast.error(
        'Cannot delete agent: Agent is not in a state to be deleted. Please wait for transactions to settle.',
      );
    }
  };

  const handleBulkDeleteAgents = async () => {
    const ids = bulkDeletableSelectedIds;
    if (ids.length === 0) return;
    if (isDeletingRef.current) return;
    isDeletingRef.current = true;
    setIsBulkDeleting(true);

    try {
      const { succeeded, failed, failedIds, skippedLimit } = await runBulkSequential(
        ids,
        async (id) => {
          const response = await deleteAgentMutation.mutateAsync({ id }).catch((error: unknown) => {
            console.error('Error deleting agent:', error);
            return null;
          });
          return Boolean(response);
        },
      );

      setIsBulkDeleteConfirmOpen(false);

      if (skippedLimit) {
        toast.error(`Select at most ${BULK_ACTION_MAX_ITEMS} agents at a time`);
        return;
      }

      if (succeeded > 0) {
        toast.success(
          `Deleted ${succeeded} agent registration${succeeded === 1 ? '' : 's'} successfully`,
        );
        refetchAfterMutation();
      }
      if (failed > 0) {
        toast.error(`Failed to delete ${failed} agent registration${failed === 1 ? '' : 's'}`);
      }

      setSelectionToIds(failedIds);
    } finally {
      isDeletingRef.current = false;
      setIsBulkDeleting(false);
    }
  };

  const openBulkDeleteConfirm = () => {
    if (bulkDeletableSelectedIds.length === 0) {
      toast.error(
        'None of the selected agents can be deleted. Choose failed or deregistered rows.',
      );
      return;
    }
    if (selectedCount > bulkDeletableSelectedIds.length) {
      toast.info('Only failed or deregistered registrations will be deleted.');
    }
    setIsBulkDeleteConfirmOpen(true);
  };

  const handleBulkDeregisterAgents = async () => {
    const ids = bulkDeregisterableSelectedIds;
    if (ids.length === 0) return;
    if (!selectedPaymentSource?.smartContractAddress) {
      toast.error('Cannot deregister agents: missing payment source');
      return;
    }
    if (isDeletingRef.current) return;
    isDeletingRef.current = true;
    setIsBulkDeregistering(true);

    const smartContractAddress = selectedPaymentSource.smartContractAddress;

    try {
      const { succeeded, failed, failedIds, skippedLimit } = await runBulkSequential(
        ids,
        async (id) => {
          const agent = agentsById.get(id);
          if (!agent?.agentIdentifier) return false;
          const response = await deregisterAgentMutation
            .mutateAsync({
              agentIdentifier: agent.agentIdentifier,
              network,
              smartContractAddress,
            })
            .catch((error: unknown) => {
              console.error('Error deregistering agent:', error);
              return null;
            });
          return Boolean(response);
        },
      );

      setIsBulkDeregisterConfirmOpen(false);

      if (skippedLimit) {
        toast.error(`Select at most ${BULK_ACTION_MAX_ITEMS} agents at a time`);
        return;
      }

      if (succeeded > 0) {
        toast.success(
          `Deregistered ${succeeded} agent${succeeded === 1 ? '' : 's'}. On-chain burn may take a few minutes.`,
        );
        refetchAfterMutation();
      }
      if (failed > 0) {
        toast.error(`Failed to deregister ${failed} agent${failed === 1 ? '' : 's'}`);
      }

      setSelectionToIds(failedIds);
    } finally {
      isDeletingRef.current = false;
      setIsBulkDeregistering(false);
    }
  };

  const openBulkDeregisterConfirm = () => {
    if (!selectedPaymentSource?.smartContractAddress) {
      toast.error('Cannot deregister agents: missing payment source');
      return;
    }
    if (bulkDeregisterableSelectedIds.length === 0) {
      toast.error(
        'None of the selected agents can be deregistered. Choose registered agents with a minted ID.',
      );
      return;
    }
    if (selectedCount > bulkDeregisterableSelectedIds.length) {
      toast.info('Only registered agents on this payment source will be deregistered.');
    }
    setIsBulkDeregisterConfirmOpen(true);
  };

  const handleAgentClick = (agent: AIAgent) => {
    openAgentDetails(agent);
  };

  const handleWalletClick = useCallback(
    async (walletVkey: string) => {
      const foundWallet = await lookupWalletByVkey({
        apiClient,
        walletVkey,
        paymentSourceId: selectedPaymentSourceId,
      });

      if (!foundWallet) {
        toast.error('Wallet not found');
        return;
      }

      setSelectedWalletForDetails(foundWallet);
    },
    [apiClient, selectedPaymentSourceId],
  );

  return (
    <MainLayout>
      <Head>
        <title>AI Agents | Admin Interface</title>
      </Head>
      <AnimatedPage>
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">AI agents</h1>
              <p className="text-sm text-muted-foreground">
                Manage your AI agents and their configurations.{' '}
                <a
                  href="https://www.masumi.network/dev/masumi/core-concepts/agentic-service"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  Learn more
                </a>
              </p>
            </div>
            <div className="flex items-center gap-2">
              <RefreshButton
                onRefresh={() => {
                  refetchAll();
                }}
                isRefreshing={isFetchingAgents}
              />
              {/* Registration and migration are Cardano-registry operations. On the x402
                  rail this page is a read-only "accepts x402" view, so these don't apply. */}
              {activeRail === 'cardano' && capabilities.canPay && canMigrate && (
                <Button
                  variant="outline"
                  className="flex items-center gap-2 btn-hover-lift"
                  onClick={() => setIsMigrateDialogOpen(true)}
                >
                  <ArrowUpRight className="h-4 w-4" />
                  Migrate to V2
                </Button>
              )}
              {activeRail === 'cardano' && capabilities.canPay && (
                <Button
                  className="flex items-center gap-2 btn-hover-lift"
                  onClick={() => setIsRegisterDialogOpen(true)}
                >
                  <Plus className="h-4 w-4" />
                  Register AI Agent
                </Button>
              )}
            </div>
          </div>

          <div className="space-y-6">
            <Tabs
              tabs={tabs}
              activeTab={activeTab}
              onTabChange={(tab) => {
                setActiveTab(tab);
                clearSelection();
              }}
            />

            <div className="flex items-center justify-between gap-4">
              <div className="flex-1 max-w-xs">
                <SearchInput
                  value={searchQuery}
                  onChange={(value) => {
                    setSearchQuery(value);
                    clearSelection();
                  }}
                  placeholder="Search by name, description, tags, or wallet..."
                  isLoading={isSearchPending && !!searchQuery}
                />
              </div>
              <Select
                value={typeFilter}
                onValueChange={(value) => {
                  setTypeFilter(value as 'All' | 'Standard' | 'OpenApi' | 'X402');
                  clearSelection();
                }}
              >
                <SelectTrigger className="w-[140px]" aria-label="Filter agents by type">
                  <SelectValue placeholder="All types" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="All">All types</SelectItem>
                    {/* Options come from the same label map as the Type column, so
                        the filter can never disagree with the badges it filters. */}
                    {Object.entries(AGENT_TYPE_LABELS).map(([type, label]) => (
                      <SelectItem key={type} value={type}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>

            {truncated && !isLoading && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-100">
                Showing the first {agents.length} agents. The list is capped, so some entries may
                not appear. Use search or the status filter to narrow down to a specific agent.
              </div>
            )}

            {showBulkSelection && (
              <BulkActionBar
                selectedCount={selectedCount}
                onClear={clearSelection}
                disabled={isBulkActionBusy || isDeleting}
              >
                {capabilities.canPay && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={openBulkDeregisterConfirm}
                    disabled={
                      isBulkActionBusy || isDeleting || bulkDeregisterableSelectedIds.length === 0
                    }
                  >
                    <Unlink className="h-4 w-4" />
                    Deregister ({bulkDeregisterableSelectedIds.length})
                  </Button>
                )}
                {capabilities.canAdmin && (
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={openBulkDeleteConfirm}
                    disabled={
                      isBulkActionBusy || isDeleting || bulkDeletableSelectedIds.length === 0
                    }
                  >
                    <Trash2 className="h-4 w-4" />
                    Delete ({bulkDeletableSelectedIds.length})
                  </Button>
                )}
              </BulkActionBar>
            )}

            <HorizontalScrollArea className="rounded-lg border">
              <table
                className={cn(
                  'w-full transition-opacity duration-150',
                  isSearchPending && 'opacity-70',
                )}
              >
                <thead className="table-header-surface">
                  <tr className="border-b">
                    {showBulkSelection && (
                      <th scope="col" className="w-12 p-4">
                        <TableSelectAllCheckbox
                          allSelected={allSelected}
                          someSelected={someSelected}
                          onToggleAll={toggleAll}
                          disabled={visibleRowIds.length === 0}
                          aria-label="Select all agents on this page"
                        />
                      </th>
                    )}
                    <th
                      scope="col"
                      className={cn(
                        'p-4 text-left text-sm font-medium text-muted-foreground',
                        !showBulkSelection && 'pl-6',
                      )}
                    >
                      Name
                    </th>
                    <th
                      scope="col"
                      className="p-4 text-left text-sm font-medium text-muted-foreground"
                    >
                      Type
                    </th>
                    <th
                      scope="col"
                      className="p-4 text-left text-sm font-medium text-muted-foreground"
                    >
                      Added
                    </th>
                    <th
                      scope="col"
                      className="p-4 text-left text-sm font-medium text-muted-foreground"
                    >
                      Agent ID
                    </th>
                    <th
                      scope="col"
                      className="p-4 text-left text-sm font-medium text-muted-foreground"
                    >
                      Wallets
                    </th>
                    <th
                      scope="col"
                      className="p-4 text-left text-sm font-medium text-muted-foreground"
                    >
                      Price
                    </th>
                    <th
                      scope="col"
                      className="p-4 text-left text-sm font-medium text-muted-foreground"
                    >
                      Tags
                    </th>
                    <th
                      scope="col"
                      className="p-4 text-left text-sm font-medium text-muted-foreground"
                    >
                      Status
                    </th>
                    <th scope="col" className={tableActionsHeadCompactClass}>
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {(isLoading && !agents.length) ||
                  (displayAgents.length === 0 && isSearchPending) ? (
                    <AIAgentTableSkeleton rows={5} columns={tableColumnCount} />
                  ) : displayAgents.length === 0 ? (
                    <tr>
                      <td colSpan={tableColumnCount}>
                        <EmptyState
                          icon={searchQuery ? 'search' : 'inbox'}
                          title={
                            searchQuery
                              ? 'No AI agents found matching your search'
                              : activeRail === 'x402'
                                ? 'No agents accept x402 payment here'
                                : 'No AI agents found'
                          }
                          description={
                            searchQuery
                              ? 'Try adjusting your search terms'
                              : activeRail === 'x402'
                                ? "Agents that accept x402 on this environment's chains will appear here."
                                : capabilities.canPay
                                  ? 'Register your first AI agent to get started'
                                  : 'Registering an agent needs an API key with pay access'
                          }
                        />
                      </td>
                    </tr>
                  ) : (
                    displayAgents.map((agent, index) => {
                      const holdingWallet = getHoldingWallet(agent);
                      const isCombinedWallet = usesCombinedWallet(agent);
                      const statusHelperText = getAgentStatusHelperText(agent.state);
                      const hasRowActions =
                        isDeregisterableAgentState(agent.state) ||
                        agent.state === 'RegistrationInitiated' ||
                        agent.state === 'DeregistrationInitiated' ||
                        agent.state === 'RegistrationRequested' ||
                        agent.state === 'DeregistrationRequested';
                      const rowIsSelected = isSelected(agent.id);

                      return (
                        <tr
                          key={agent.id}
                          className={cn(
                            'group border-b cursor-pointer hover:bg-row-hover transition-[background-color,opacity] duration-150 opacity-0',
                            rowIsSelected && 'bg-row-hover',
                            agent.state === 'DeregistrationConfirmed'
                              ? 'animate-fade-in-to-muted'
                              : 'animate-fade-in',
                          )}
                          style={{
                            animationDelay: `${Math.min(index, 9) * 40}ms`,
                          }}
                          aria-label={`View details for ${agent.name}`}
                          onClick={() => handleAgentClick(agent)}
                          {...rowActivation(() => handleAgentClick(agent))}
                        >
                          {showBulkSelection && (
                            <td className="p-4" onClick={(event) => event.stopPropagation()}>
                              <TableSelectRowCheckbox
                                aria-label={`Select ${agent.name}`}
                                checked={rowIsSelected}
                                onToggle={() => toggleRow(agent.id)}
                              />
                            </td>
                          )}
                          <td className={cn('p-4 max-w-50 truncate', !showBulkSelection && 'pl-6')}>
                            <div className="text-sm font-medium truncate" title={agent.name}>
                              {agent.name}
                            </div>
                            <div
                              className="text-xs text-muted-foreground truncate"
                              title={agent.description ?? undefined}
                            >
                              {agent.description}
                            </div>
                          </td>
                          <td className="p-4">
                            {/* Neutral outline: Status is the only colour-bearing
                                badge in the row, and the Wallets cell already
                                carries a RelationBadge. */}
                            <Badge variant="outline" className="whitespace-nowrap">
                              {getAgentTypeLabel(agent.type)}
                            </Badge>
                          </td>
                          <td className="p-4 text-sm">{formatDate(agent.createdAt)}</td>
                          <td className="p-4">
                            {agent.agentIdentifier ? (
                              <div className="text-xs font-mono truncate max-w-50 flex items-center gap-2">
                                <a
                                  href={getExplorerUrl(agent.agentIdentifier, network, 'token')}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  onClick={(e) => e.stopPropagation()}
                                  className="text-primary hover:underline flex items-center gap-1 truncate"
                                >
                                  {shortenAddress(agent.agentIdentifier)}
                                  <ExternalLink className="h-3 w-3 shrink-0" />
                                </a>
                                <CopyButton value={agent.agentIdentifier} />
                              </div>
                            ) : (
                              <span className="text-xs text-muted-foreground">
                                {getAgentIdentifierPlaceholder(agent.state)}
                              </span>
                            )}
                          </td>
                          <td className="p-4 align-top">
                            <div
                              className={cn(
                                'space-y-2',
                                isCombinedWallet ? 'w-fit max-w-md' : 'min-w-[15rem]',
                              )}
                            >
                              <RelationBadge relation={agent.relation} />
                              <div
                                className={cn(
                                  'rounded-md border bg-muted/10 p-2.5',
                                  isCombinedWallet && 'w-fit max-w-full',
                                )}
                              >
                                {isCombinedWallet ? (
                                  <AgentWalletRow
                                    variant="combined"
                                    label="Minting & holding"
                                    address={holdingWallet.walletAddress}
                                    walletVkey={holdingWallet.walletVkey}
                                    onWalletClick={handleWalletClick}
                                  />
                                ) : (
                                  <div className="flex items-stretch gap-3">
                                    <AgentWalletRow
                                      label="Minting"
                                      address={agent.SmartContractWallet.walletAddress}
                                      walletVkey={agent.SmartContractWallet.walletVkey}
                                      onWalletClick={handleWalletClick}
                                    />
                                    <Separator orientation="vertical" className="h-auto" />
                                    <AgentWalletRow
                                      label="Holding"
                                      address={holdingWallet.walletAddress}
                                      walletVkey={holdingWallet.walletVkey}
                                      onWalletClick={handleWalletClick}
                                    />
                                  </div>
                                )}
                              </div>
                            </div>
                          </td>
                          <td className="p-4 text-sm truncate max-w-25">
                            {(() => {
                              const pricing = getPrimaryCardanoPricing(agent);
                              if (pricing?.pricingType === 'Free') {
                                return <div className="whitespace-nowrap">Free</div>;
                              }
                              if (pricing?.pricingType === 'Dynamic') {
                                return <div className="whitespace-nowrap">Dynamic</div>;
                              }
                              if (pricing?.pricingType === 'Fixed') {
                                return pricing.Pricing.map((price, index) => (
                                  <div key={index} className="whitespace-nowrap">
                                    {formatAssetAmount(price.amount, price.unit, network)}
                                  </div>
                                ));
                              }
                              return null;
                            })()}
                            {agentHasX402Options(agent.supportedPaymentSources) && (
                              <div className="mt-1">
                                <Badge variant="secondary">x402</Badge>
                              </div>
                            )}
                            {agentHasVerifications(agent.verifications) && (
                              <div className="mt-1">
                                <Badge variant="outline">Verifiable</Badge>
                              </div>
                            )}
                          </td>
                          <td className="p-4">
                            {agent.Tags.length > 0 && (
                              <Badge variant="secondary" className="truncate">
                                {agent.Tags.length} tags
                              </Badge>
                            )}
                          </td>
                          <td className="p-4">
                            <div className="space-y-1">
                              <Badge variant={getAgentStatusBadgeVariant(agent.state)}>
                                {parseAgentStatus(agent.state)}
                              </Badge>
                              {statusHelperText && (
                                <p
                                  className="text-xs text-muted-foreground max-w-48 truncate"
                                  title={statusHelperText}
                                >
                                  {statusHelperText}
                                </p>
                              )}
                            </div>
                          </td>
                          <td
                            className={cn(
                              rowIsSelected
                                ? tableActionsCellCompactSelectedClass
                                : tableActionsCellCompactClass,
                              !hasRowActions && 'pointer-events-none',
                            )}
                            onClick={hasRowActions ? (event) => event.stopPropagation() : undefined}
                          >
                            <div className={tableActionsInnerClass}>
                              {isDeregisterableAgentState(agent.state) ? (
                                <AIAgentRowActionsMenu
                                  showVerifyPublish={agent.relation !== 'payment'}
                                  showUpdateMetadata={canEditAgentMetadata({
                                    relation: agent.relation,
                                    canPay: capabilities.canPay,
                                    selectedPaymentSource,
                                  })}
                                  showDeleteOrDeregister={
                                    agent.relation !== 'payment' &&
                                    (agent.state === 'RegistrationFailed' ||
                                    agent.state === 'DeregistrationConfirmed'
                                      ? capabilities.canAdmin
                                      : capabilities.canPay)
                                  }
                                  deleteLabel={
                                    agent.state === 'RegistrationFailed' ||
                                    agent.state === 'DeregistrationConfirmed'
                                      ? 'Delete agent'
                                      : 'Deregister agent'
                                  }
                                  onVerifyPublish={() => setSelectedAgentForVerification(agent)}
                                  onViewDetails={() => handleAgentClick(agent)}
                                  onViewEarnings={() =>
                                    openAgentDetails(agent, { initialTab: 'Earnings' })
                                  }
                                  onUpdateMetadata={() => handleUpdateClick(agent)}
                                  onDeleteOrDeregister={() => handleDeleteClick(agent)}
                                />
                              ) : agent.state === 'RegistrationInitiated' ||
                                agent.state === 'DeregistrationInitiated' ? (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  disabled
                                  className="text-primary"
                                  title="Processing on-chain"
                                >
                                  <Spinner size={16} />
                                </Button>
                              ) : (
                                (agent.state === 'RegistrationRequested' ||
                                  agent.state === 'DeregistrationRequested') && (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    disabled
                                    className="text-primary"
                                    title={getAgentStatusHelperText(agent.state) ?? 'Pending'}
                                  >
                                    <FaRegClock />
                                  </Button>
                                )
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </HorizontalScrollArea>

            <div className="flex flex-col gap-4 items-center">
              {!(isLoading && !agents.length) && (
                <Pagination
                  hasMore={hasMoreAgents}
                  isLoading={isFetchingNextPage || (isFetchingAgents && !isPlaceholderData)}
                  onLoadMore={loadMore}
                />
              )}
            </div>
          </div>

          <RegisterAIAgentDialog
            open={shouldOpenRegisterDialog}
            onClose={() => {
              setIsRegisterDialogOpen(false);
            }}
            onSuccess={() => {
              void refetchAfterMutation();
            }}
          />

          <RegisterAIAgentDialog
            open={!!selectedAgentToUpdate}
            editingAgent={selectedAgentToUpdate}
            editingAgentSmartContractAddress={updateAgentSmartContractAddress ?? undefined}
            onClose={() => {
              setSelectedAgentToUpdate(null);
              setUpdateAgentSmartContractAddress(null);
            }}
            onSuccess={() => {
              setSelectedAgentToUpdate(null);
              setUpdateAgentSmartContractAddress(null);
              void refetchAfterMutation();
            }}
          />

          <VerifyAndPublishAgentDialog
            agent={selectedAgentForVerification}
            open={!!selectedAgentForVerification}
            onClose={() => setSelectedAgentForVerification(null)}
          />

          <ConfirmDialog
            open={isDeleteDialogOpen}
            onClose={() => {
              setIsDeleteDialogOpen(false);
              setSelectedAgentToDelete(null);
            }}
            title={
              selectedAgentToDelete?.state === 'RegistrationFailed' ||
              selectedAgentToDelete?.state === 'DeregistrationConfirmed'
                ? `Delete ${selectedAgentToDelete?.name}`
                : `Deregister ${selectedAgentToDelete?.name}`
            }
            description={
              selectedAgentToDelete?.state === 'RegistrationFailed' ||
              selectedAgentToDelete?.state === 'DeregistrationConfirmed'
                ? `Are you sure you want to delete "${selectedAgentToDelete?.name}"? This action cannot be undone.`
                : `Are you sure you want to deregister "${selectedAgentToDelete?.name}"? This action cannot be undone.`
            }
            onConfirm={async () => {
              await handleDeleteConfirm();
              closeAgentDetails();
            }}
            isLoading={isDeleting}
          />

          <ConfirmDialog
            open={isBulkDeleteConfirmOpen}
            onClose={() => setIsBulkDeleteConfirmOpen(false)}
            title="Delete agent registrations"
            description={`Delete ${bulkDeletableSelectedIds.length} failed or deregistered agent registration${bulkDeletableSelectedIds.length === 1 ? '' : 's'} from the database? This cannot be undone.`}
            onConfirm={() => void handleBulkDeleteAgents()}
            isLoading={isBulkDeleting}
          />

          <ConfirmDialog
            open={isBulkDeregisterConfirmOpen}
            onClose={() => setIsBulkDeregisterConfirmOpen(false)}
            title="Deregister agents"
            description={`Deregister ${bulkDeregisterableSelectedIds.length} agent${bulkDeregisterableSelectedIds.length === 1 ? '' : 's'} on-chain? This starts a burn for each minted registration and cannot be undone.`}
            onConfirm={() => void handleBulkDeregisterAgents()}
            isLoading={isBulkDeregistering}
          />

          <WalletDetailsDialog
            isOpen={!!selectedWalletForDetails}
            onClose={() => setSelectedWalletForDetails(null)}
            wallet={selectedWalletForDetails}
          />

          <MigrateAgentsDialog
            open={isMigrateDialogOpen}
            onClose={() => setIsMigrateDialogOpen(false)}
            onSuccess={() => {
              void refetchAfterMutation();
            }}
          />
        </div>
      </AnimatedPage>
    </MainLayout>
  );
}
