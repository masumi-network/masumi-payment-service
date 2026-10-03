import { isBulkDeletableAgent, isBulkDeregisterableAgent } from '@/lib/agent-table-actions';
import { MainLayout } from '@/components/layout/MainLayout';

import { useState, useCallback, useMemo, useEffect, useRef } from 'react';

import { useRouter } from 'next/router';
import { RegisterAIAgentDialog } from '@/components/ai-agents/RegisterAIAgentDialog';

import { useAppContext } from '@/lib/contexts/AppContext';
import { deleteRegistry, postRegistryDeregister } from '@/lib/api/generated';

import { toast } from 'react-toastify';
import { useApiMutation } from '@/lib/hooks/useApiMutation';
import Head from 'next/head';

import { useQueryClient } from '@tanstack/react-query';
import { useContextAgents } from '@/lib/queries/useContextAgents';
import { invalidateAgentQueries, resetAgentQueries } from '@/lib/queries/agent-cache';

import { isDeregisterableAgentState } from '@/lib/registry-states';

import {
  BULK_ACTION_MAX_ITEMS,
  runBulkSequential,
  useTableSelection,
} from '@/lib/hooks/useTableSelection';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

import { Pagination } from '@/components/ui/pagination';
import { VerifyAndPublishAgentDialog } from '@/components/ai-agents/VerifyAndPublishAgentDialog';
import { WalletDetailsDialog, WalletWithBalance } from '@/components/wallets/WalletDetailsDialog';

import { usePaymentSourceExtendedAll } from '@/lib/hooks/usePaymentSourceExtendedAll';
import { AnimatedPage } from '@/components/ui/animated-page';

import { Select } from '@/components/ui/select';
import { useDebouncedValue } from '@/lib/hooks/useDebouncedValue';
import { filterAgentsClientSide } from '@/lib/client-search/agent-search';
import { useRegistryEntryByAgentIdentifier } from '@/lib/queries/useRegistryEntryByAgentIdentifier';
import { useAgentDetailsDialog } from '@/lib/contexts/AgentDetailsDialogContext';
import { lookupWalletByVkey } from '@/lib/wallet-lookup';
import { isV2PaymentSource } from '@/lib/payment-source-type';

import { MigrateAgentsDialog } from '@/components/ai-agents/MigrateAgentsDialog';

import { AIAgentRow, type AIAgent } from '@/components/ai-agents/AIAgentRow';
import { AIAgentsList } from '@/components/ai-agents/AIAgentsList';
import { supportsAgentMetadataUpdate, UNSUPPORTED_AGENT_UPDATE_MESSAGE } from '@/lib/agent-update';

export default function AIAgentsPage() {
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState('');
  const [isRegisterDialogOpen, setIsRegisterDialogOpen] = useState(false);
  const [isMigrateDialogOpen, setIsMigrateDialogOpen] = useState(false);
  const debouncedSearchQuery = useDebouncedValue(searchQuery);

  const [activeTab, setActiveTab] = useState('All');
  const [typeFilter, setTypeFilter] = useState<'All' | 'Standard' | 'OpenApi' | 'X402' | 'A2A'>(
    'All',
  );

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
    if (!supportsAgentMetadataUpdate(agent)) {
      toast.error(UNSUPPORTED_AGENT_UPDATE_MESSAGE);
      return;
    }
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
          <AIAgentsList
            activeRail={activeRail}
            capabilities={capabilities}
            canMigrate={canMigrate}
            isFetchingAgents={isFetchingAgents}
            refetchAll={refetchAll}
            onMigrate={() => setIsMigrateDialogOpen(true)}
            onRegister={() => setIsRegisterDialogOpen(true)}
            tabs={tabs}
            activeTab={activeTab}
            onTabChange={(tab) => {
              setActiveTab(tab);
              clearSelection();
            }}
            searchQuery={searchQuery}
            onSearchChange={(value) => {
              setSearchQuery(value);
              clearSelection();
            }}
            isSearchPending={isSearchPending}
            typeFilter={typeFilter}
            onTypeFilterChange={(value) => {
              setTypeFilter(value as typeof typeFilter);
              clearSelection();
            }}
            truncated={truncated}
            isLoading={isLoading}
            agentCount={agents.length}
            displayAgentCount={displayAgents.length}
            showBulkSelection={showBulkSelection}
            selectedCount={selectedCount}
            clearSelection={clearSelection}
            isBulkActionBusy={isBulkActionBusy}
            isDeleting={isDeleting}
            openBulkDeregisterConfirm={openBulkDeregisterConfirm}
            openBulkDeleteConfirm={openBulkDeleteConfirm}
            deregisterableCount={bulkDeregisterableSelectedIds.length}
            deletableCount={bulkDeletableSelectedIds.length}
            allSelected={allSelected}
            someSelected={someSelected}
            toggleAll={toggleAll}
            visibleRowCount={visibleRowIds.length}
            tableColumnCount={tableColumnCount}
          >
            {displayAgents.map((agent, index) => (
              <AIAgentRow
                key={agent.id}
                agent={agent}
                index={index}
                network={network}
                isSelected={isSelected(agent.id)}
                showBulkSelection={showBulkSelection}
                capabilities={capabilities}
                selectedPaymentSource={selectedPaymentSource}
                onToggleSelection={() => toggleRow(agent.id)}
                onSelect={handleAgentClick}
                onWalletClick={handleWalletClick}
                onVerify={setSelectedAgentForVerification}
                onEarnings={(entry) => openAgentDetails(entry, { initialTab: 'Earnings' })}
                onUpdate={handleUpdateClick}
                onDelete={handleDeleteClick}
              />
            ))}
          </AIAgentsList>
          <div className="space-y-6">
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
