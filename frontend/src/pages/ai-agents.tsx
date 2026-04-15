import { Button } from '@/components/ui/button';
import { MainLayout } from '@/components/layout/MainLayout';
import { Plus, Trash2, ExternalLink, ShieldCheck } from 'lucide-react';
import { RefreshButton } from '@/components/RefreshButton';
import { useState, useCallback, useMemo } from 'react';

import { useRouter } from 'next/router';
import { RegisterAIAgentDialog } from '@/components/ai-agents/RegisterAIAgentDialog';
import { Badge } from '@/components/ui/badge';

import { cn, shortenAddress } from '@/lib/utils';
import { useAppContext } from '@/lib/contexts/AppContext';
import {
  deleteRegistry,
  RegistryEntry,
  A2aRegistryEntry,
  postRegistryDeregister,
} from '@/lib/api/generated';
import { toast } from 'react-toastify';
import { handleApiCall } from '@/lib/utils';
import Head from 'next/head';
import { AIAgentTableSkeleton } from '@/components/skeletons/AIAgentTableSkeleton';
import { Spinner } from '@/components/ui/spinner';
import { useQueryClient } from '@tanstack/react-query';
import { useAgents } from '@/lib/queries/useAgents';
import { useA2AAgents } from '@/lib/queries/useA2AAgents';
import formatBalance from '@/lib/formatBalance';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { FaRegClock } from 'react-icons/fa';
import { Tabs } from '@/components/ui/tabs';
import { Pagination } from '@/components/ui/pagination';
import { AIAgentDetailsDialog } from '@/components/ai-agents/AIAgentDetailsDialog';
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
import { findPaymentSourceWalletByVkey } from '@/lib/wallet-lookup';

type AIAgent = RegistryEntry | A2aRegistryEntry;

const getHoldingWallet = (agent: AIAgent) => agent.RecipientWallet ?? agent.SmartContractWallet;

const usesCombinedWallet = (agent: AIAgent) =>
  getHoldingWallet(agent).walletVkey === agent.SmartContractWallet.walletVkey;

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
  const debouncedSearchQuery = useDebouncedValue(searchQuery);

  const [activeTab, setActiveTab] = useState('All');

  const filterStatus = useMemo(() => {
    if (activeTab === 'All') return undefined;
    return activeTab as 'Registered' | 'Deregistered' | 'Pending' | 'Failed';
  }, [activeTab]);

  // Use React Query for initial load (cached)
  const {
    agents: standardAgents,
    isLoading: isLoadingStandard,
    isFetching: isFetchingAgents,
    isPlaceholderData,
    refetch: refetchStandard,
    hasMore: hasMoreAgents,
    loadMore,
  } = useAgents({
    filterStatus,
    searchQuery: debouncedSearchQuery || undefined,
  });

  const {
    agents: a2aAgents,
    isLoading: isLoadingA2A,
    hasMore: hasMoreA2A,
    loadMore: loadMoreA2A,
    refetch: refetchA2A,
  } = useA2AAgents({
    filterStatus,
    searchQuery: debouncedSearchQuery || undefined,
  });

  const agents = useMemo(
    () =>
      [...standardAgents, ...a2aAgents].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      ),
    [standardAgents, a2aAgents],
  );

  const isLoading = isLoadingStandard || isLoadingA2A;

  const refetch = useCallback(() => {
    void refetchStandard();
    void refetchA2A();
  }, [refetchStandard, refetchA2A]);

  const queryClient = useQueryClient();

  const refetchAll = useCallback(() => {
    void refetch();
    void queryClient.invalidateQueries({ queryKey: ['wallets'] });
  }, [refetch, queryClient]);

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
  const { apiClient, network, selectedPaymentSourceId } = useAppContext();
  const { paymentSources } = usePaymentSourceExtendedAll();

  const currentNetworkPaymentSources = useMemo(
    () => paymentSources.filter((paymentSource) => paymentSource.network === network),
    [paymentSources, network],
  );
  const [selectedAgentForDetails, setSelectedAgentForDetails] = useState<AIAgent | null>(null);
  const [selectedAgentForVerification, setSelectedAgentForVerification] = useState<AIAgent | null>(
    null,
  );
  const [initialDialogTab, setInitialDialogTab] = useState<'Details' | 'Earnings'>('Details');
  const [selectedWalletForDetails, setSelectedWalletForDetails] =
    useState<WalletWithBalance | null>(null);

  const tabs = [
    { name: 'All', count: null },
    { name: 'Registered', count: null },
    { name: 'Deregistered', count: null },
    { name: 'Pending', count: null },
    { name: 'Failed', count: null },
  ];

  const [dismissedQueryAction, setDismissedQueryAction] = useState(false);

  const shouldOpenRegisterDialog =
    isRegisterDialogOpen || (router.query.action === 'register_agent' && !dismissedQueryAction);

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

  const handleDeleteConfirm = async () => {
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
      setIsDeleting(true);
      await handleApiCall(
        () =>
          postRegistryDeregister({
            client: apiClient,
            body: {
              agentIdentifier: selectedAgentToDelete.agentIdentifier!,
              network: network,
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
    setSelectedAgentForDetails(agent);
  };

  const handleWalletClick = useCallback(
    (walletVkey: string) => {
      const filteredSources = currentNetworkPaymentSources.filter((source) =>
        selectedPaymentSourceId ? source.id === selectedPaymentSourceId : true,
      );
      const foundWallet = findPaymentSourceWalletByVkey(filteredSources, walletVkey);

      if (!foundWallet) {
        toast.error('Wallet not found');
        return;
      }

      setSelectedWalletForDetails(foundWallet);
    },
    [currentNetworkPaymentSources, selectedPaymentSourceId],
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
              <Button
                className="flex items-center gap-2 btn-hover-lift"
                onClick={() => setIsRegisterDialogOpen(true)}
              >
                <Plus className="h-4 w-4" />
                Register AI Agent
              </Button>
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

            <div className="rounded-lg border overflow-x-auto">
              <table
                className={cn(
                  'w-full transition-opacity duration-150',
                  isSearchPending && 'opacity-70',
                )}
              >
                <thead className="bg-muted/30 dark:bg-muted/15">
                  <tr className="border-b">
                    <th className="p-4 text-left text-sm font-medium text-muted-foreground pl-6">
                      Name
                    </th>
                    <th className="p-4 text-left text-sm font-medium text-muted-foreground">
                      Type
                    </th>
                    <th className="p-4 text-left text-sm font-medium text-muted-foreground">
                      Added
                    </th>
                    <th className="p-4 text-left text-sm font-medium text-muted-foreground">
                      Agent ID
                    </th>
                    <th className="p-4 text-left text-sm font-medium text-muted-foreground">
                      Wallets
                    </th>
                    <th className="p-4 text-left text-sm font-medium text-muted-foreground">
                      Price
                    </th>
                    <th className="p-4 text-left text-sm font-medium text-muted-foreground">
                      Tags
                    </th>
                    <th className="p-4 text-left text-sm font-medium text-muted-foreground">
                      Status
                    </th>
                    <th className="w-20 p-4 pr-8"></th>
                  </tr>
                </thead>
                <tbody>
                  {(isLoading && !agents.length) ||
                  (displayAgents.length === 0 && isSearchPending) ? (
                    <AIAgentTableSkeleton rows={5} />
                  ) : displayAgents.length === 0 ? (
                    <tr>
                      <td colSpan={9}>
                        <EmptyState
                          icon={searchQuery ? 'search' : 'inbox'}
                          title={
                            searchQuery
                              ? 'No AI agents found matching your search'
                              : 'No AI agents found'
                          }
                          description={
                            searchQuery
                              ? 'Try adjusting your search terms'
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
                          onClick={() => handleAgentClick(agent)}
                        >
                          <td className="p-4 max-w-50 truncate pl-6">
                            <div className="text-sm font-medium">{agent.name}</div>
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
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setInitialDialogTab('Earnings');
                                    handleAgentClick(agent);
                                  }}
                                  className="text-white hover:text-gray-200 hover:bg-gray-600"
                                  title="View Details & Earnings"
                                >
                                  <ExternalLink className="h-4 w-4" />
                                </Button>
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
                  hasMore={hasMoreAgents || hasMoreA2A}
                  isLoading={isFetchingAgents}
                  onLoadMore={() => {
                    void loadMore();
                    void loadMoreA2A();
                  }}
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

          <AIAgentDetailsDialog
            agent={selectedAgentForDetails}
            onClose={() => {
              setSelectedAgentForDetails(null);
              setInitialDialogTab('Details'); // Reset to default tab
            }}
            onSuccess={() => {
              setTimeout(() => {
                refetchAll();
              }, 2000);
            }}
            initialTab={initialDialogTab}
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
              setSelectedAgentForDetails(null);
            }}
            isLoading={isDeleting}
          />

          <WalletDetailsDialog
            isOpen={!!selectedWalletForDetails}
            onClose={() => setSelectedWalletForDetails(null)}
            wallet={selectedWalletForDetails}
          />
        </div>
      </AnimatedPage>
    </MainLayout>
  );
}
