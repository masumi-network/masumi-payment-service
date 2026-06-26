import { Button } from '@/components/ui/button';
import { MainLayout } from '@/components/layout/MainLayout';
import { Plus, Pencil, Trash2, ExternalLink, ShieldCheck, ArrowUpRight } from 'lucide-react';
import { RefreshButton } from '@/components/RefreshButton';
import { useState, useCallback, useMemo, useEffect, useRef } from 'react';

import { useRouter } from 'next/router';
import { RegisterAIAgentDialog } from '@/components/ai-agents/RegisterAIAgentDialog';
import { Badge } from '@/components/ui/badge';

import { cn, shortenAddress } from '@/lib/utils';
import { useAppContext } from '@/lib/contexts/AppContext';
import { deleteRegistry, RegistryEntry, postRegistryDeregister } from '@/lib/api/generated';
import { agentHasX402Options } from '@/components/ai-agents/AgentX402Options';
import { agentHasVerifications } from '@/components/ai-agents/AgentVerifications';
import { toast } from 'react-toastify';
import { handleApiCall } from '@/lib/utils';
import Head from 'next/head';
import { AIAgentTableSkeleton } from '@/components/skeletons/AIAgentTableSkeleton';
import { Spinner } from '@/components/ui/spinner';
import { useQueryClient } from '@tanstack/react-query';
import { useContextAgents, type AgentRelation } from '@/lib/queries/useContextAgents';
import { invalidateAgentQueries } from '@/lib/queries/agent-cache';
import { rowActivation } from '@/lib/a11y';
import formatBalance from '@/lib/formatBalance';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { FaRegClock } from 'react-icons/fa';
import { Tabs } from '@/components/ui/tabs';
import { Pagination } from '@/components/ui/pagination';
import { VerifyAndPublishAgentDialog } from '@/components/ai-agents/VerifyAndPublishAgentDialog';
import { WalletDetailsDialog, WalletWithBalance } from '@/components/wallets/WalletDetailsDialog';
import { CopyButton } from '@/components/ui/copy-button';
import { TESTUSDM_CONFIG, getUsdmConfig, getUsdcxConfig } from '@/lib/constants/defaultWallets';
import { usePaymentSourceExtendedAll } from '@/lib/hooks/usePaymentSourceExtendedAll';
import { AnimatedPage } from '@/components/ui/animated-page';
import { EmptyState } from '@/components/ui/empty-state';
import { SearchInput } from '@/components/ui/search-input';
import { useDebouncedValue } from '@/lib/hooks/useDebouncedValue';
import { parseAmountSearchRange } from '@/lib/parseAmountSearchRange';
import { extractApiErrorMessage } from '@/lib/api-error';
import { useRegistryEntryByAgentIdentifier } from '@/lib/queries/useRegistryEntryByAgentIdentifier';
import { useAgentDetailsDialog } from '@/lib/contexts/AgentDetailsDialogContext';
import { lookupWalletByVkey } from '@/lib/wallet-lookup';
import { isV2PaymentSource } from '@/lib/payment-source-type';
import { MigrateAgentsDialog } from '@/components/ai-agents/MigrateAgentsDialog';
type AIAgent = RegistryEntry & { relation?: AgentRelation };

// Tells apart agents registered on the active source from those registered elsewhere that
// merely accept payment on it (or over x402 on an EVM chain).
function RelationBadge({ relation }: { relation?: AgentRelation }) {
  if (relation === 'payment') {
    return (
      <Badge
        variant="outline"
        className="mt-1 border-indigo-300 bg-indigo-50 text-[10px] text-indigo-700 dark:border-indigo-900/60 dark:bg-indigo-950/30 dark:text-indigo-300"
      >
        Payment accepted
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="mt-1 text-[10px]">
      On this source
    </Badge>
  );
}

const getHoldingWallet = (agent: AIAgent) => agent.RecipientWallet ?? agent.SmartContractWallet;

const usesCombinedWallet = (agent: AIAgent) =>
  getHoldingWallet(agent).walletVkey === agent.SmartContractWallet.walletVkey;

const parseAgentStatus = (status: AIAgent['state']): string => {
  switch (status) {
    case 'RegistrationRequested':
      return 'Pending';
    case 'RegistrationInitiated':
      return 'Registering';
    case 'RegistrationConfirmed':
      return 'Registered';
    case 'RegistrationFailed':
      return 'Registration Failed';
    case 'DeregistrationRequested':
      return 'Pending';
    case 'DeregistrationInitiated':
      return 'Deregistering';
    case 'DeregistrationConfirmed':
      return 'Deregistered';
    case 'DeregistrationFailed':
      return 'Deregistration Failed';
    default:
      return status;
  }
};

export default function AIAgentsPage() {
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState('');
  const [isRegisterDialogOpen, setIsRegisterDialogOpen] = useState(false);
  const [isMigrateDialogOpen, setIsMigrateDialogOpen] = useState(false);
  const debouncedSearchQuery = useDebouncedValue(searchQuery);

  const [activeTab, setActiveTab] = useState('All');

  const filterStatus = useMemo(() => {
    if (activeTab === 'All') return undefined;
    return activeTab as 'Registered' | 'Deregistered' | 'Pending' | 'Failed';
  }, [activeTab]);

  // Rail-aware agent list: shows agents registered on the active context plus those
  // registered elsewhere that accept payment on it (Cardano source, or EVM chains over
  // x402). The list is fetched in full and filtered client-side, so there is no server
  // cursor to page — the load-more control is inert here.
  const {
    agents,
    truncated,
    isLoading,
    isFetching: isFetchingAgents,
    isPlaceholderData,
  } = useContextAgents({
    filterStatus,
    searchQuery: debouncedSearchQuery || undefined,
  });
  const hasMoreAgents = false;
  const loadMore = () => {};

  const queryClient = useQueryClient();
  const { openAgentDetails, closeAgentDetails } = useAgentDetailsDialog();

  const refetchAll = useCallback(() => {
    // Invalidate the full ['context-agents'] and ['agents'] prefixes so EVERY status-tab /
    // search variant refetches (not just the active query), and the dashboard / testing
    // dialogs reflect the mutation too. Also refresh wallet balances (fees/settlement).
    invalidateAgentQueries(queryClient);
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
    const query = searchQuery.toLowerCase().trim();
    if (!query || (query === debouncedSearchQuery.toLowerCase().trim() && !isPlaceholderData))
      return agents;

    const amountRange = parseAmountSearchRange(query);

    return agents.filter((agent) => {
      if (agent.name?.toLowerCase().includes(query)) return true;
      if (agent.description?.toLowerCase().includes(query)) return true;
      // Backend uses hasSome (exact match against tag array), not partial
      if (agent.Tags?.some((tag) => tag.toLowerCase() === query)) return true;
      if (agent.SmartContractWallet?.walletAddress?.toLowerCase().includes(query)) return true;
      if (agent.RecipientWallet?.walletAddress?.toLowerCase().includes(query)) return true;
      if (agent.state?.toLowerCase().includes(query)) return true;
      if (agent.AgentPricing?.pricingType === 'Free' && 'free'.startsWith(query)) return true;
      if (agent.AgentPricing?.pricingType === 'Dynamic' && 'dynamic'.startsWith(query)) return true;
      if (
        amountRange &&
        agent.AgentPricing?.pricingType === 'Fixed' &&
        agent.AgentPricing.Pricing?.some((p) => {
          const amt = parseInt(p.amount);
          return amt >= amountRange.min && amt <= amountRange.max;
        })
      )
        return true;
      return false;
    });
  }, [agents, searchQuery, debouncedSearchQuery, isPlaceholderData]);

  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [selectedAgentToDelete, setSelectedAgentToDelete] = useState<AIAgent | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
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
  const { apiClient, network, selectedPaymentSourceId, selectedPaymentSource, activeRail } =
    useAppContext();
  const { paymentSources } = usePaymentSourceExtendedAll();

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
  // migrate into. The dashboard nudge (useMigrationStatus) remains the entry
  // point for migrating regardless of which source is selected.
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

  const [dismissedQueryAction, setDismissedQueryAction] = useState(false);

  // Registration is Cardano-only, so the register_agent deep link must not pop the dialog
  // while the x402 rail is active (the button is hidden there too).
  const shouldOpenRegisterDialog =
    activeRail === 'cardano' &&
    (isRegisterDialogOpen || (router.query.action === 'register_agent' && !dismissedQueryAction));

  const formatDate = (date: Date | string) => {
    const dateObj = typeof date === 'string' ? new Date(date) : date;
    return dateObj.toLocaleDateString();
  };

  const getStatusBadgeVariant = (status: AIAgent['state']) => {
    if (status === 'RegistrationConfirmed') return 'default';
    if (status.includes('Failed')) return 'destructive';
    if (status.includes('Initiated')) return 'processing';
    if (status.includes('Requested')) return 'pending';
    if (status === 'DeregistrationConfirmed') return 'secondary';
    return 'secondary';
  };

  const formatPrice = (amount: string | undefined) => {
    if (!amount) return '—';
    return formatBalance((parseInt(amount) / 1000000).toFixed(2));
  };

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
      setIsDeleting(true);
      await handleApiCall(
        () =>
          deleteRegistry({
            client: apiClient,
            body: {
              id: selectedAgentToDelete.id,
            },
          }),
        {
          onSuccess: () => {
            toast.success('AI agent deleted successfully');
            setIsDeleteDialogOpen(false);
            setSelectedAgentToDelete(null);
            refetchAll();
          },
          onError: (error: unknown) => {
            console.error('Error deleting agent:', error);
            toast.error(extractApiErrorMessage(error, 'Failed to delete AI agent'));
          },
          onFinally: () => {
            setIsDeleting(false);
          },
          errorMessage: 'Failed to delete AI agent',
        },
      );
    } else if (selectedAgentToDelete?.state === 'RegistrationConfirmed') {
      if (!selectedAgentToDelete?.agentIdentifier) {
        toast.error('Cannot deregister agent: Missing identifier');
        return;
      }
      if (!selectedPaymentSource?.smartContractAddress) {
        toast.error('Cannot deregister agent: Missing payment source');
        return;
      }
      setIsDeleting(true);
      await handleApiCall(
        () =>
          postRegistryDeregister({
            client: apiClient,
            body: {
              agentIdentifier: selectedAgentToDelete.agentIdentifier!,
              network: network,
              smartContractAddress: selectedPaymentSource.smartContractAddress,
            },
          }),
        {
          onSuccess: () => {
            toast.success('AI agent deregistered successfully');
            setIsDeleteDialogOpen(false);
            setSelectedAgentToDelete(null);
            refetchAll();
          },
          onError: (error: unknown) => {
            console.error('Error deregistering agent:', error);
            toast.error(extractApiErrorMessage(error, 'Failed to deregister AI agent'));
          },
          onFinally: () => {
            setIsDeleting(false);
          },
          errorMessage: 'Failed to deregister AI agent',
        },
      );
    } else {
      toast.error(
        'Cannot delete agent: Agent is not in a state to be deleted. Please wait for transactions to settle.',
      );
    }
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
                  href="https://docs.masumi.network/core-concepts/agentic-service"
                  target="_blank"
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
              {activeRail === 'cardano' && canMigrate && (
                <Button
                  variant="outline"
                  className="flex items-center gap-2 btn-hover-lift"
                  onClick={() => setIsMigrateDialogOpen(true)}
                >
                  <ArrowUpRight className="h-4 w-4" />
                  Migrate to V2
                </Button>
              )}
              {activeRail === 'cardano' && (
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
              }}
            />

            <div className="flex items-center justify-between gap-4">
              <div className="flex-1 max-w-xs">
                <SearchInput
                  value={searchQuery}
                  onChange={setSearchQuery}
                  placeholder="Search by name, description, tags, or wallet..."
                  isLoading={isSearchPending && !!searchQuery}
                />
              </div>
            </div>

            {truncated && !isLoading && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-100">
                Showing the first {agents.length} agents. The list is capped, so some entries may
                not appear. Use search or the status filter to narrow down to a specific agent.
              </div>
            )}

            <div className="rounded-lg border overflow-x-auto">
              <table
                className={cn(
                  'w-full transition-opacity duration-150',
                  isSearchPending && 'opacity-70',
                )}
              >
                <thead className="bg-muted/30 dark:bg-muted/15">
                  <tr className="border-b">
                    <th
                      scope="col"
                      className="p-4 text-left text-sm font-medium text-muted-foreground pl-6"
                    >
                      Name
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
                    <th scope="col" className="w-20 p-4 pr-8"></th>
                  </tr>
                </thead>
                <tbody>
                  {(isLoading && !agents.length) ||
                  (displayAgents.length === 0 && isSearchPending) ? (
                    <AIAgentTableSkeleton rows={5} />
                  ) : displayAgents.length === 0 ? (
                    <tr>
                      <td colSpan={8}>
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
                                : 'Register your first AI agent to get started'
                          }
                        />
                      </td>
                    </tr>
                  ) : (
                    displayAgents.map((agent, index) => {
                      const holdingWallet = getHoldingWallet(agent);
                      const isCombinedWallet = usesCombinedWallet(agent);

                      return (
                        <tr
                          key={agent.id}
                          className={cn(
                            'border-b cursor-pointer hover:bg-muted/50 transition-[background-color,opacity] duration-150 opacity-0',
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
                          <td className="p-4 max-w-50 truncate pl-6">
                            <div className="text-sm font-medium">{agent.name}</div>
                            <RelationBadge relation={agent.relation} />
                            <div className="text-xs text-muted-foreground truncate">
                              {agent.description}
                            </div>
                          </td>
                          <td className="p-4 text-sm">{formatDate(agent.createdAt)}</td>
                          <td className="p-4">
                            {agent.agentIdentifier ? (
                              <div className="text-xs font-mono truncate max-w-50 flex items-center gap-2">
                                <span className="cursor-pointer hover:text-primary">
                                  {shortenAddress(agent.agentIdentifier)}
                                </span>
                                <CopyButton value={agent.agentIdentifier} />
                              </div>
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="p-4">
                            <div className="space-y-2">
                              {isCombinedWallet ? (
                                <div>
                                  <div className="text-xs font-medium">
                                    Minting & holding wallet
                                  </div>
                                  <div className="text-xs text-muted-foreground font-mono truncate max-w-50 flex items-center gap-2">
                                    <span
                                      className="cursor-pointer hover:text-primary"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleWalletClick(holdingWallet.walletVkey);
                                      }}
                                    >
                                      {shortenAddress(holdingWallet.walletAddress)}
                                    </span>
                                    <CopyButton value={holdingWallet.walletAddress} />
                                  </div>
                                </div>
                              ) : (
                                <>
                                  <div>
                                    <div className="text-xs font-medium">Minting wallet</div>
                                    <div className="text-xs text-muted-foreground font-mono truncate max-w-50 flex items-center gap-2">
                                      <span
                                        className="cursor-pointer hover:text-primary"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          handleWalletClick(agent.SmartContractWallet.walletVkey);
                                        }}
                                      >
                                        {shortenAddress(agent.SmartContractWallet.walletAddress)}
                                      </span>
                                      <CopyButton value={agent.SmartContractWallet.walletAddress} />
                                    </div>
                                  </div>
                                  <div>
                                    <div className="text-xs font-medium">Holding wallet</div>
                                    <div className="text-xs text-muted-foreground font-mono truncate max-w-50 flex items-center gap-2">
                                      <span
                                        className="cursor-pointer hover:text-primary"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          handleWalletClick(holdingWallet.walletVkey);
                                        }}
                                      >
                                        {shortenAddress(holdingWallet.walletAddress)}
                                      </span>
                                      <CopyButton value={holdingWallet.walletAddress} />
                                    </div>
                                  </div>
                                </>
                              )}
                            </div>
                          </td>
                          <td className="p-4 text-sm truncate max-w-25">
                            {agent.AgentPricing && agent.AgentPricing.pricingType == 'Free' && (
                              <div className="whitespace-nowrap">Free</div>
                            )}
                            {agent.AgentPricing && agent.AgentPricing.pricingType == 'Dynamic' && (
                              <div className="whitespace-nowrap">Dynamic</div>
                            )}
                            {agent.AgentPricing &&
                              agent.AgentPricing.pricingType == 'Fixed' &&
                              agent.AgentPricing.Pricing?.map((price, index) => (
                                <div key={index} className="whitespace-nowrap">
                                  {price.unit === 'lovelace' || !price.unit
                                    ? `${formatPrice(price.amount)} ADA`
                                    : `${formatPrice(price.amount)} ${price.unit === getUsdcxConfig(network).fullAssetId ? 'USDCx' : price.unit === getUsdmConfig(network).fullAssetId ? (network === 'Mainnet' ? 'USDM' : 'tUSDM') : price.unit === TESTUSDM_CONFIG.unit ? 'tUSDM' : price.unit}`}
                                </div>
                              ))}
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
                            <Badge
                              variant={getStatusBadgeVariant(agent.state)}
                              className={cn(
                                agent.state === 'RegistrationConfirmed' &&
                                  'bg-green-50 text-green-700 hover:bg-green-50/80',
                              )}
                            >
                              {parseAgentStatus(agent.state)}
                            </Badge>
                          </td>
                          <td className="p-4 pr-8">
                            {['RegistrationConfirmed'].includes(agent.state) ? (
                              <div className="flex items-center gap-1">
                                {/* Manage actions (verify/update/delete) only apply to agents
                                    registered on the active source. Agents shown because they
                                    accept payment here are managed from their home source. */}
                                {agent.relation !== 'payment' && (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setSelectedAgentForVerification(agent);
                                    }}
                                    className="text-primary hover:text-primary hover:bg-primary/10"
                                    title="Verify and Publish"
                                  >
                                    <ShieldCheck className="h-4 w-4" />
                                  </Button>
                                )}
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    openAgentDetails(agent, { initialTab: 'Earnings' });
                                  }}
                                  className="text-white hover:text-gray-200 hover:bg-gray-600"
                                  title="View Details & Earnings"
                                >
                                  <ExternalLink className="h-4 w-4" />
                                </Button>
                                {agent.relation !== 'payment' &&
                                  selectedPaymentSource &&
                                  isV2PaymentSource(selectedPaymentSource) && (
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleUpdateClick(agent);
                                      }}
                                      className="text-primary hover:text-primary hover:bg-primary/10"
                                      title="Update agent metadata (V2)"
                                    >
                                      <Pencil className="h-4 w-4" />
                                    </Button>
                                  )}
                                {agent.relation !== 'payment' && (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleDeleteClick(agent);
                                    }}
                                    className="text-destructive hover:text-destructive hover:bg-destructive/10 group"
                                  >
                                    <Trash2 className="h-4 w-4 transition-transform duration-200 group-hover:scale-110" />
                                  </Button>
                                )}
                              </div>
                            ) : agent.state === 'RegistrationInitiated' ||
                              agent.state === 'DeregistrationInitiated' ? (
                              <div className="flex items-center justify-center w-8 h-8">
                                <Spinner size={16} />
                              </div>
                            ) : (
                              (agent.state === 'RegistrationRequested' ||
                                agent.state === 'DeregistrationRequested') && (
                                <div className="flex items-center justify-center w-8 h-8">
                                  <FaRegClock size={12} />
                                </div>
                              )
                            )}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            <div className="flex flex-col gap-4 items-center">
              {!(isLoading && !agents.length) && (
                <Pagination
                  hasMore={hasMoreAgents}
                  isLoading={isFetchingAgents}
                  onLoadMore={loadMore}
                />
              )}
            </div>
          </div>

          <RegisterAIAgentDialog
            open={shouldOpenRegisterDialog}
            onClose={() => {
              setIsRegisterDialogOpen(false);
              if (router.query.action === 'register_agent') {
                setDismissedQueryAction(true);
                void router.replace('/ai-agents', undefined, { shallow: true });
              }
            }}
            onSuccess={() => {
              setTimeout(() => {
                refetchAll();
              }, 250);
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
              setTimeout(() => {
                refetchAll();
              }, 250);
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

          <WalletDetailsDialog
            isOpen={!!selectedWalletForDetails}
            onClose={() => setSelectedWalletForDetails(null)}
            wallet={selectedWalletForDetails}
          />

          <MigrateAgentsDialog
            open={isMigrateDialogOpen}
            onClose={() => setIsMigrateDialogOpen(false)}
            onSuccess={() => {
              setTimeout(() => refetchAll(), 250);
            }}
          />
        </div>
      </AnimatedPage>
    </MainLayout>
  );
}
