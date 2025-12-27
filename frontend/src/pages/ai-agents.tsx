/* eslint-disable react-hooks/exhaustive-deps, react-hooks/rules-of-hooks, @typescript-eslint/no-explicit-any */

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { MainLayout } from '@/components/layout/MainLayout';
import { Plus, Search, Trash2, ExternalLink } from 'lucide-react';
import { RefreshButton } from '@/components/RefreshButton';
import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import { RegisterAIAgentDialog } from '@/components/ai-agents/RegisterAIAgentDialog';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { cn, shortenAddress } from '@/lib/utils';
import { useAppContext } from '@/lib/contexts/AppContext';
import {
  getRegistry,
  deleteRegistry,
  GetRegistryResponses,
  postRegistryDeregister,
} from '@/lib/api/generated';
import { toast } from 'react-toastify';
import { handleApiCall } from '@/lib/utils';
import Head from 'next/head';
import { Spinner } from '@/components/ui/spinner';
import { useAgents } from '@/lib/queries/useAgents';
import formatBalance from '@/lib/formatBalance';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { FaRegClock } from 'react-icons/fa';
import { Tabs } from '@/components/ui/tabs';
import { Pagination } from '@/components/ui/pagination';
import { AIAgentDetailsDialog } from '@/components/ai-agents/AIAgentDetailsDialog';
import {
  WalletDetailsDialog,
  WalletWithBalance,
} from '@/components/wallets/WalletDetailsDialog';
import { CopyButton } from '@/components/ui/copy-button';
import { TESTUSDM_CONFIG, getUsdmConfig } from '@/lib/constants/defaultWallets';
type AIAgent = GetRegistryResponses['200']['data']['Assets'][0];

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
  const [selectedAgents, setSelectedAgents] = useState<string[]>([]);
  const [allAgents, setAllAgents] = useState<AIAgent[]>([]);
  const [filteredAgents, setFilteredAgents] = useState<AIAgent[]>([]);

  // Use React Query for initial load (cached)
  const {
    data: initialAgentsData,
    isLoading: isLoadingInitial,
    isFetching: isFetchingAgents,
    refetch: refetchAgentsQuery,
  } = useAgents();

  // Initialize allAgents from cached data
  useEffect(() => {
    if (initialAgentsData?.agents) {
      setAllAgents(initialAgentsData.agents);
      setHasMore(initialAgentsData.hasMore || false);
    }
  }, [initialAgentsData]);

  const isLoading = isLoadingInitial && allAgents.length === 0;

  // Helper to refetch agents (uses React Query refetch)
  const refetchAgents = useCallback(async () => {
    await refetchAgentsQuery();
  }, [refetchAgentsQuery]);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [selectedAgentToDelete, setSelectedAgentToDelete] =
    useState<AIAgent | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const { apiClient, state, selectedPaymentSourceId } = useAppContext();
  const [activeTab, setActiveTab] = useState('All');
  const [hasMore, setHasMore] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [selectedAgentForDetails, setSelectedAgentForDetails] =
    useState<AIAgent | null>(null);
  const [initialDialogTab, setInitialDialogTab] = useState<
    'Details' | 'Earnings'
  >('Details');
  const [selectedWalletForDetails, setSelectedWalletForDetails] =
    useState<WalletWithBalance | null>(null);

  const tabs = [
    { name: 'All', count: null },
    { name: 'Registered', count: null },
    { name: 'Deregistered', count: null },
    { name: 'Pending', count: null },
    { name: 'Failed', count: null },
  ];

  const filterAgents = useCallback(() => {
    let filtered = [...allAgents];

    if (activeTab === 'Registered') {
      filtered = filtered.filter(
        (agent) => parseAgentStatus(agent.state) === 'Registered',
      );
    } else if (activeTab === 'Deregistered') {
      filtered = filtered.filter(
        (agent) => parseAgentStatus(agent.state) === 'Deregistered',
      );
    } else if (activeTab === 'Pending') {
      filtered = filtered.filter(
        (agent) => parseAgentStatus(agent.state) === 'Pending',
      );
    } else if (activeTab === 'Failed') {
      filtered = filtered.filter(
        (agent) => agent.state && agent.state.includes('Failed'),
      );
    }

    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter((agent) => {
        const matchName = agent.name?.toLowerCase().includes(query) || false;
        const matchDescription =
          agent.description?.toLowerCase().includes(query) || false;
        const matchTags =
          agent.Tags?.some((tag) => tag.toLowerCase().includes(query)) || false;
        const matchWallet =
          agent.SmartContractWallet?.walletAddress
            ?.toLowerCase()
            .includes(query) || false;
        const matchState = agent.state?.toLowerCase().includes(query) || false;
        const matchPrice =
          agent.AgentPricing &&
            agent.AgentPricing.pricingType == 'Fixed' &&
            agent.AgentPricing.Pricing?.[0]?.amount
            ? (parseInt(agent.AgentPricing.Pricing[0].amount) / 1000000)
              .toFixed(2)
              .includes(query)
            : agent.AgentPricing &&
            agent.AgentPricing.pricingType == 'Free' &&
            'free'.includes(query);

        return (
          matchName ||
          matchDescription ||
          matchTags ||
          matchWallet ||
          matchState ||
          matchPrice
        );
      });
    }

    setFilteredAgents(filtered);
  }, [allAgents, searchQuery, activeTab]);

  // fetchAgents is now only used for pagination (load more)
  // Initial load is handled by useAgents hook above
  const loadMoreAgents = useCallback(
    async (cursor: string) => {

      setIsLoadingMore(true);

      const selectedPaymentSource = state.paymentSources.find(
        (ps) => ps.id === selectedPaymentSourceId,
      );
      const smartContractAddress = selectedPaymentSource?.smartContractAddress;

      const response = await handleApiCall(
        () =>
          getRegistry({
            client: apiClient,
            query: {
              network: state.network,
              cursorId: cursor || undefined,
              filterSmartContractAddress: smartContractAddress
                ? smartContractAddress
                : undefined,
            },
          }),
        {
          onError: (error: any) => {
            console.error('Error fetching agents:', error);
            toast.error(error.message || 'Failed to load AI agents');
            if (!cursor) {
              setAllAgents([]);
            }
            setHasMore(false);
            setIsLoadingMore(false);
          },
          onFinally: () => {
            setIsLoadingMore(false);
          },
          errorMessage: 'Failed to load AI agents',
        },
      );

      if (!response) return;

      if (response.data?.data?.Assets) {
        const newAgents = response.data.data.Assets;
        if (cursor) {
          setAllAgents((prev) => [...prev, ...newAgents]);
        } else {
          setAllAgents(newAgents);
        }

        setHasMore(newAgents.length === 10);
      } else {
        if (!cursor) {
          setAllAgents([]);
        }
        setHasMore(false);
      }
    },
    [apiClient, state.network, selectedPaymentSourceId],
  );

  const handleLoadMore = () => {
    if (!isLoadingMore && hasMore && allAgents.length > 0) {
      const lastAgent = allAgents[allAgents.length - 1];
      loadMoreAgents(lastAgent.id);
    }
  };

  // Initial load is handled by useAgents hook - no useEffect needed

  useEffect(() => {
    filterAgents();
  }, [filterAgents, searchQuery, activeTab]);

  // Handle action query parameter from search
  useEffect(() => {
    if (router.query.action === 'register_agent') {
      setIsRegisterDialogOpen(true);
      // Clean up the query parameter
      router.replace('/ai-agents', undefined, { shallow: true });
    }
  }, [router.query.action, router]);

  const handleSelectAgent = (id: string) => {
    setSelectedAgents((prev) =>
      prev.includes(id)
        ? prev.filter((agentId) => agentId !== id)
        : [...prev, id],
    );
  };

  const handleSelectAll = () => {
    if (allAgents.length === 0) {
      setSelectedAgents([]);
      return;
    }

    if (selectedAgents.length === allAgents.length) {
      setSelectedAgents([]);
    } else {
      setSelectedAgents(allAgents.map((agent) => agent.id));
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString();
  };

  const getStatusBadgeVariant = (status: AIAgent['state']) => {
    if (status === 'RegistrationConfirmed') return 'default';
    if (status.includes('Failed')) return 'destructive';
    if (status.includes('Initiated')) return 'secondary';
    if (status.includes('Requested')) return 'secondary';
    if (status === 'DeregistrationConfirmed') return 'secondary';
    return 'secondary';
  };

  const useFormatPrice = (amount: string | undefined) => {
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
            refetchAgents();
          },
          onError: (error: any) => {
            console.error('Error deleting agent:', error);
            toast.error(error.message || 'Failed to delete AI agent');
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
              network: state.network,
            },
          }),
        {
          onSuccess: () => {
            toast.success('AI agent deregistered successfully');
            setIsDeleteDialogOpen(false);
            setSelectedAgentToDelete(null);
            refetchAgents();
          },
          onError: (error: any) => {
            console.error('Error deregistering agent:', error);
            toast.error(error.message || 'Failed to deregister AI agent');
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

  const handleWalletClick = async (walletVkey: string) => {
    // Find the wallet by vkey from payment sources in context
    const filteredSources = state.paymentSources.filter(
      (source: any) =>
        source.network === state.network &&
        (selectedPaymentSourceId
          ? source.id === selectedPaymentSourceId
          : true),
    );

    // Flatten all wallets from filtered sources
    const allWallets = filteredSources.flatMap((source: any) => [
      ...(source.SellingWallets || []).map((wallet: any) => ({
        ...wallet,
        type: 'Selling' as const,
        balance: '0',
        usdmBalance: '0',
      })),
      ...(source.PurchasingWallets || []).map((wallet: any) => ({
        ...wallet,
        type: 'Purchasing' as const,
        balance: '0',
        usdmBalance: '0',
      })),
    ]);

    const foundWallet = allWallets.find(
      (wallet: any) => wallet.walletVkey === walletVkey,
    );

    if (!foundWallet) {
      toast.error('Wallet not found');
      return;
    }

    setSelectedWalletForDetails(foundWallet as WalletWithBalance);
  };

  return (
    <MainLayout>
      <Head>
        <title>AI Agents | Admin Interface</title>
      </Head>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold mb-1">AI agents</h1>
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
              onRefresh={refetchAgents}
              isRefreshing={isFetchingAgents}
            />
            <Button
              className="flex items-center gap-2"
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
              setAllAgents([]);
              refetchAgents();
            }}
          />

          <div className="flex items-center justify-between gap-4">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground h-4 w-4" />
              <Input
                type="search"
                placeholder="Search by name, description, tags, or wallet..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="max-w-xs pl-10"
              />
            </div>
          </div>

          <div className="rounded-lg border overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b">
                  <th className="w-12 p-4">
                    <Checkbox
                      checked={
                        allAgents.length > 0 &&
                        selectedAgents.length === allAgents.length
                      }
                      onCheckedChange={handleSelectAll}
                    />
                  </th>
                  <th className="p-4 text-left text-sm font-medium">Name</th>
                  <th className="p-4 text-left text-sm font-medium">Added</th>
                  <th className="p-4 text-left text-sm font-medium">
                    Agent ID
                  </th>
                  <th className="p-4 text-left text-sm font-medium">
                    Linked wallet
                  </th>
                  <th className="p-4 text-left text-sm font-medium">Price</th>
                  <th className="p-4 text-left text-sm font-medium">Tags</th>
                  <th className="p-4 text-left text-sm font-medium">Status</th>
                  <th className="w-20 p-4"></th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr>
                    <td colSpan={8}>
                      <Spinner size={20} addContainer />
                    </td>
                  </tr>
                ) : filteredAgents.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="text-center py-8">
                      {searchQuery
                        ? 'No AI agents found matching your search'
                        : 'No AI agents found'}
                    </td>
                  </tr>
                ) : (
                  filteredAgents.map((agent) => (
                    <tr
                      key={agent.id}
                      className="border-b cursor-pointer hover:bg-muted/50"
                      style={{
                        opacity:
                          agent.state === 'DeregistrationConfirmed'
                            ? '0.4'
                            : '1',
                      }}
                      onClick={() => handleAgentClick(agent)}
                    >
                      <td className="p-4" onClick={(e) => e.stopPropagation()}>
                        <Checkbox
                          checked={selectedAgents.includes(agent.id)}
                          onCheckedChange={() => handleSelectAgent(agent.id)}
                        />
                      </td>
                      <td className="p-4 max-w-[200px] truncate">
                        <div className="text-sm font-medium">{agent.name}</div>
                        <div className="text-xs text-muted-foreground truncate">
                          {agent.description}
                        </div>
                      </td>
                      <td className="p-4 text-sm">
                        {formatDate(agent.createdAt)}
                      </td>
                      <td className="p-4">
                        {agent.agentIdentifier ? (
                          <div className="text-xs font-mono truncate max-w-[200px] flex items-center gap-2">
                            <span className="cursor-pointer hover:text-primary">
                              {shortenAddress(agent.agentIdentifier)}
                            </span>
                            <CopyButton value={agent.agentIdentifier} />
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            —
                          </span>
                        )}
                      </td>
                      <td className="p-4">
                        <div className="text-xs font-medium">
                          Selling wallet
                        </div>
                        <div className="text-xs text-muted-foreground font-mono truncate max-w-[200px] flex items-center gap-2">
                          <span
                            className="cursor-pointer hover:text-primary"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleWalletClick(
                                agent.SmartContractWallet.walletVkey,
                              );
                            }}
                          >
                            {shortenAddress(
                              agent.SmartContractWallet.walletAddress,
                            )}
                          </span>
                          <CopyButton
                            value={agent.SmartContractWallet.walletAddress}
                          />
                        </div>
                      </td>
                      <td className="p-4 text-sm truncate max-w-[100px]">
                        {agent.AgentPricing &&
                          agent.AgentPricing.pricingType == 'Free' && (
                            <div className="whitespace-nowrap">Free</div>
                          )}
                        {agent.AgentPricing &&
                          agent.AgentPricing.pricingType == 'Fixed' &&
                          agent.AgentPricing.Pricing?.map((price, index) => (
                            <div key={index} className="whitespace-nowrap">
                              {price.unit === 'lovelace' || !price.unit
                                ? `${useFormatPrice(price.amount)} ADA`
                                : `${useFormatPrice(price.amount)} ${price.unit === getUsdmConfig(state.network).fullAssetId ? 'USDM' : price.unit === TESTUSDM_CONFIG.unit ? 'tUSDM' : price.unit}`}
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
                      <td className="p-4">
                        {['RegistrationConfirmed'].includes(agent.state) ? (
                          <div className="flex items-center gap-1">
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
                              className="text-destructive hover:text-destructive hover:bg-destructive/10"
                            >
                              <Trash2 className="h-4 w-4" />
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
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div className="flex flex-col gap-4 items-center">
            {!isLoading && (
              <Pagination
                hasMore={hasMore}
                isLoading={isLoadingMore}
                onLoadMore={handleLoadMore}
              />
            )}
          </div>
        </div>

        <RegisterAIAgentDialog
          open={isRegisterDialogOpen}
          onClose={() => setIsRegisterDialogOpen(false)}
          onSuccess={() => {
            setTimeout(() => {
              refetchAgents();
            }, 2000);
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
              refetchAgents();
            }, 2000);
          }}
          initialTab={initialDialogTab}
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
    </MainLayout>
  );
}
