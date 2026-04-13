import Head from 'next/head';
import { useRouter } from 'next/router';
import { useCallback, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Plus, Trash2 } from 'lucide-react';
import { FaRegClock } from 'react-icons/fa';
import { toast } from 'react-toastify';
import { MainLayout } from '@/components/layout/MainLayout';
import { AnimatedPage } from '@/components/ui/animated-page';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { CopyButton } from '@/components/ui/copy-button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Pagination } from '@/components/ui/pagination';
import { SearchInput } from '@/components/ui/search-input';
import { Spinner } from '@/components/ui/spinner';
import { Tabs } from '@/components/ui/tabs';
import { WalletDetailsDialog, WalletWithBalance } from '@/components/wallets/WalletDetailsDialog';
import { AIAgentTableSkeleton } from '@/components/skeletons/AIAgentTableSkeleton';
import { RefreshButton } from '@/components/RefreshButton';
import { InboxAgentDetailsDialog } from '@/components/inbox-agents/InboxAgentDetailsDialog';
import { RegisterInboxAgentDialog } from '@/components/inbox-agents/RegisterInboxAgentDialog';
import {
  deleteInboxAgents,
  postInboxAgentsDeregister,
  RegistryInboxEntry,
} from '@/lib/api/generated';
import { extractApiErrorMessage } from '@/lib/api-error';
import { useAppContext } from '@/lib/contexts/AppContext';
import { useDebouncedValue } from '@/lib/hooks/useDebouncedValue';
import { usePaymentSourceExtendedAll } from '@/lib/hooks/usePaymentSourceExtendedAll';
import { useInboxAgents } from '@/lib/queries/useInboxAgents';
import { findPaymentSourceWalletByVkey } from '@/lib/wallet-lookup';
import { cn, handleApiCall, shortenAddress } from '@/lib/utils';

type InboxAgent = RegistryInboxEntry;

const getHoldingWallet = (agent: InboxAgent) => agent.RecipientWallet ?? agent.SmartContractWallet;

const usesCombinedWallet = (agent: InboxAgent) =>
  getHoldingWallet(agent).walletVkey === agent.SmartContractWallet.walletVkey;

const parseInboxAgentStatus = (status: InboxAgent['state']): string => {
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

const getStatusBadgeVariant = (status: InboxAgent['state']) => {
  if (status === 'RegistrationConfirmed') return 'default';
  if (status.includes('Failed')) return 'destructive';
  if (status.includes('Initiated')) return 'processing';
  if (status.includes('Requested')) return 'pending';
  if (status === 'DeregistrationConfirmed') return 'secondary';
  return 'secondary';
};

function formatDate(date: Date | string) {
  const value = typeof date === 'string' ? new Date(date) : date;
  return value.toLocaleDateString();
}

function formatLovelaceToAda(amount: string | null) {
  if (!amount) {
    return 'Default minimum';
  }

  return `${(parseInt(amount, 10) / 1000000).toFixed(2)} ADA`;
}

export default function InboxAgentsPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { apiClient, network, selectedPaymentSourceId } = useAppContext();
  const { paymentSources } = usePaymentSourceExtendedAll();
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState('All');
  const [dismissedQueryAction, setDismissedQueryAction] = useState(false);
  const [isRegisterDialogOpen, setIsRegisterDialogOpen] = useState(false);
  const [selectedInboxAgent, setSelectedInboxAgent] = useState<InboxAgent | null>(null);
  const [selectedWalletForDetails, setSelectedWalletForDetails] =
    useState<WalletWithBalance | null>(null);
  const [selectedInboxAgentToDelete, setSelectedInboxAgentToDelete] = useState<InboxAgent | null>(
    null,
  );
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const debouncedSearchQuery = useDebouncedValue(searchQuery);

  const filterStatus = useMemo(() => {
    if (activeTab === 'All') return undefined;
    return activeTab as 'Registered' | 'Deregistered' | 'Pending' | 'Failed';
  }, [activeTab]);

  const { inboxAgents, isLoading, isFetching, isPlaceholderData, refetch, hasMore, loadMore } =
    useInboxAgents({
      filterStatus,
      searchQuery: debouncedSearchQuery || undefined,
    });

  const refetchAll = useCallback(() => {
    void refetch();
    void queryClient.invalidateQueries({ queryKey: ['wallets'] });
  }, [queryClient, refetch]);

  const currentNetworkPaymentSources = useMemo(
    () => paymentSources.filter((paymentSource) => paymentSource.network === network),
    [paymentSources, network],
  );

  const isSearchPending = searchQuery !== debouncedSearchQuery || (isFetching && isPlaceholderData);

  const displayInboxAgents = useMemo(() => {
    const query = searchQuery.toLowerCase().trim();
    if (!query || (query === debouncedSearchQuery.toLowerCase().trim() && !isPlaceholderData)) {
      return inboxAgents;
    }

    return inboxAgents.filter((agent) => {
      if (agent.name.toLowerCase().includes(query)) return true;
      if (agent.description?.toLowerCase().includes(query)) return true;
      if (agent.agentSlug.toLowerCase().includes(query)) return true;
      if (agent.SmartContractWallet.walletAddress.toLowerCase().includes(query)) return true;
      if (agent.RecipientWallet?.walletAddress?.toLowerCase().includes(query)) return true;
      if (agent.state.toLowerCase().includes(query)) return true;
      return false;
    });
  }, [debouncedSearchQuery, inboxAgents, isPlaceholderData, searchQuery]);

  const tabs = [
    { name: 'All', count: null },
    { name: 'Registered', count: null },
    { name: 'Deregistered', count: null },
    { name: 'Pending', count: null },
    { name: 'Failed', count: null },
  ];

  const shouldOpenRegisterDialog =
    isRegisterDialogOpen ||
    (router.query.action === 'register_inbox_agent' && !dismissedQueryAction);

  const handleWalletClick = useCallback(
    (walletVkey: string) => {
      const filteredSources = currentNetworkPaymentSources.filter((source) =>
        selectedPaymentSourceId ? source.id === selectedPaymentSourceId : true,
      );
      const wallet = findPaymentSourceWalletByVkey(filteredSources, walletVkey);

      if (!wallet) {
        toast.error('Wallet not found');
        return;
      }

      setSelectedWalletForDetails(wallet);
    },
    [currentNetworkPaymentSources, selectedPaymentSourceId],
  );

  const handleDeleteClick = (agent: InboxAgent) => {
    setSelectedInboxAgentToDelete(agent);
    setIsDeleteDialogOpen(true);
  };

  const handleDeleteConfirm = async () => {
    if (!selectedInboxAgentToDelete) {
      return;
    }

    if (
      selectedInboxAgentToDelete.state === 'RegistrationFailed' ||
      selectedInboxAgentToDelete.state === 'DeregistrationConfirmed'
    ) {
      setIsDeleting(true);
      await handleApiCall(
        () =>
          deleteInboxAgents({
            client: apiClient,
            body: {
              id: selectedInboxAgentToDelete.id,
            },
          }),
        {
          onSuccess: () => {
            toast.success('Inbox agent deleted successfully');
            setIsDeleteDialogOpen(false);
            setSelectedInboxAgentToDelete(null);
            setSelectedInboxAgent(null);
            refetchAll();
          },
          onError: (error: unknown) => {
            toast.error(extractApiErrorMessage(error, 'Failed to delete inbox agent'));
          },
          onFinally: () => {
            setIsDeleting(false);
          },
          errorMessage: 'Failed to delete inbox agent',
        },
      );
      return;
    }

    if (selectedInboxAgentToDelete.state === 'RegistrationConfirmed') {
      if (!selectedInboxAgentToDelete.agentIdentifier) {
        toast.error('Cannot deregister inbox agent: Missing identifier');
        return;
      }

      const selectedPaymentSource = currentNetworkPaymentSources.find(
        (paymentSource) => paymentSource.id === selectedPaymentSourceId,
      );
      if (!selectedPaymentSource) {
        toast.error('Cannot deregister inbox agent: Missing payment source');
        return;
      }

      setIsDeleting(true);
      await handleApiCall(
        () =>
          postInboxAgentsDeregister({
            client: apiClient,
            body: {
              agentIdentifier: selectedInboxAgentToDelete.agentIdentifier!,
              network,
              smartContractAddress: selectedPaymentSource.smartContractAddress || undefined,
            },
          }),
        {
          onSuccess: () => {
            toast.success('Inbox agent deregistration initiated successfully');
            setIsDeleteDialogOpen(false);
            setSelectedInboxAgentToDelete(null);
            setSelectedInboxAgent(null);
            refetchAll();
          },
          onError: (error: unknown) => {
            toast.error(extractApiErrorMessage(error, 'Failed to deregister inbox agent'));
          },
          onFinally: () => {
            setIsDeleting(false);
          },
          errorMessage: 'Failed to deregister inbox agent',
        },
      );
      return;
    }

    toast.error(
      'Cannot modify this inbox agent yet. Please wait until pending states have been resolved.',
    );
  };

  return (
    <MainLayout>
      <Head>
        <title>Inbox Agents | Admin Interface</title>
      </Head>
      <AnimatedPage>
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">Inbox agents</h1>
              <p className="text-sm text-muted-foreground">
                Manage inbox registry NFTs, managed holding wallets, and deregistration state.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <RefreshButton onRefresh={refetchAll} isRefreshing={isFetching} />
              <Button
                id="add-inbox-agent-button"
                className="flex items-center gap-2 btn-hover-lift"
                onClick={() => setIsRegisterDialogOpen(true)}
              >
                <Plus className="h-4 w-4" />
                Register Inbox Agent
              </Button>
            </div>
          </div>

          <div className="space-y-6">
            <Tabs tabs={tabs} activeTab={activeTab} onTabChange={setActiveTab} />

            <div className="flex items-center justify-between gap-4">
              <div className="flex-1 max-w-xs">
                <SearchInput
                  value={searchQuery}
                  onChange={setSearchQuery}
                  placeholder="Search by name, description, slug, or wallet..."
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
                      Added
                    </th>
                    <th className="p-4 text-left text-sm font-medium text-muted-foreground">
                      Agent ID
                    </th>
                    <th className="p-4 text-left text-sm font-medium text-muted-foreground">
                      Wallets
                    </th>
                    <th className="p-4 text-left text-sm font-medium text-muted-foreground">
                      Inbox slug
                    </th>
                    <th className="p-4 text-left text-sm font-medium text-muted-foreground">
                      Funding
                    </th>
                    <th className="p-4 text-left text-sm font-medium text-muted-foreground">
                      Status
                    </th>
                    <th className="w-24 p-4 pr-8"></th>
                  </tr>
                </thead>
                <tbody>
                  {(isLoading && !inboxAgents.length) ||
                  (displayInboxAgents.length === 0 && isSearchPending) ? (
                    <AIAgentTableSkeleton rows={5} />
                  ) : displayInboxAgents.length === 0 ? (
                    <tr>
                      <td colSpan={8}>
                        <EmptyState
                          icon={searchQuery ? 'search' : 'inbox'}
                          title={
                            searchQuery
                              ? 'No inbox agents found matching your search'
                              : 'No inbox agents found'
                          }
                          description={
                            searchQuery
                              ? 'Try adjusting your search terms'
                              : 'Register your first inbox agent to get started'
                          }
                        />
                      </td>
                    </tr>
                  ) : (
                    displayInboxAgents.map((agent, index) => {
                      const holdingWallet = getHoldingWallet(agent);
                      const isCombinedWallet = usesCombinedWallet(agent);
                      const canDelete =
                        agent.state === 'RegistrationConfirmed' ||
                        agent.state === 'RegistrationFailed' ||
                        agent.state === 'DeregistrationConfirmed';

                      return (
                        <tr
                          key={agent.id}
                          className={cn(
                            'border-b cursor-pointer hover:bg-muted/50 transition-[background-color,opacity] duration-150 opacity-0',
                            agent.state === 'DeregistrationConfirmed'
                              ? 'animate-fade-in-to-muted'
                              : 'animate-fade-in',
                          )}
                          style={{ animationDelay: `${Math.min(index, 9) * 40}ms` }}
                          onClick={() => setSelectedInboxAgent(agent)}
                        >
                          <td className="p-4 max-w-64 truncate pl-6">
                            <div className="text-sm font-medium">{agent.name}</div>
                            <div className="text-xs text-muted-foreground truncate">
                              {agent.description || 'No description'}
                            </div>
                          </td>
                          <td className="p-4 text-sm">{formatDate(agent.createdAt)}</td>
                          <td className="p-4">
                            {agent.agentIdentifier ? (
                              <div className="text-xs font-mono truncate max-w-56 flex items-center gap-2">
                                <span>{shortenAddress(agent.agentIdentifier)}</span>
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
                                    Minting &amp; holding wallet
                                  </div>
                                  <div className="text-xs text-muted-foreground font-mono truncate max-w-56 flex items-center gap-2">
                                    <button
                                      type="button"
                                      className="hover:text-primary"
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        handleWalletClick(holdingWallet.walletVkey);
                                      }}
                                    >
                                      {shortenAddress(holdingWallet.walletAddress)}
                                    </button>
                                    <CopyButton value={holdingWallet.walletAddress} />
                                  </div>
                                </div>
                              ) : (
                                <>
                                  <div>
                                    <div className="text-xs font-medium">Minting wallet</div>
                                    <div className="text-xs text-muted-foreground font-mono truncate max-w-56 flex items-center gap-2">
                                      <button
                                        type="button"
                                        className="hover:text-primary"
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          handleWalletClick(agent.SmartContractWallet.walletVkey);
                                        }}
                                      >
                                        {shortenAddress(agent.SmartContractWallet.walletAddress)}
                                      </button>
                                      <CopyButton value={agent.SmartContractWallet.walletAddress} />
                                    </div>
                                  </div>
                                  <div>
                                    <div className="text-xs font-medium">Holding wallet</div>
                                    <div className="text-xs text-muted-foreground font-mono truncate max-w-56 flex items-center gap-2">
                                      <button
                                        type="button"
                                        className="hover:text-primary"
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          handleWalletClick(holdingWallet.walletVkey);
                                        }}
                                      >
                                        {shortenAddress(holdingWallet.walletAddress)}
                                      </button>
                                      <CopyButton value={holdingWallet.walletAddress} />
                                    </div>
                                  </div>
                                </>
                              )}
                            </div>
                          </td>
                          <td className="p-4 text-sm font-mono">{agent.agentSlug}</td>
                          <td className="p-4 text-sm">
                            {formatLovelaceToAda(agent.sendFundingLovelace)}
                          </td>
                          <td className="p-4">
                            <Badge
                              variant={getStatusBadgeVariant(agent.state)}
                              className={cn(
                                agent.state === 'RegistrationConfirmed' &&
                                  'bg-green-50 text-green-700 hover:bg-green-50/80',
                              )}
                            >
                              {parseInboxAgentStatus(agent.state)}
                            </Badge>
                          </td>
                          <td className="p-4 pr-8">
                            <div className="flex items-center gap-1">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setSelectedInboxAgent(agent);
                                }}
                                className="text-primary hover:text-primary hover:bg-primary/10"
                                title="View details"
                              >
                                <ExternalLink className="h-4 w-4" />
                              </Button>
                              {canDelete ? (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    handleDeleteClick(agent);
                                  }}
                                  className="text-destructive hover:text-destructive hover:bg-destructive/10 group"
                                  title={
                                    agent.state === 'RegistrationConfirmed'
                                      ? 'Deregister inbox agent'
                                      : 'Delete inbox agent'
                                  }
                                >
                                  <Trash2 className="h-4 w-4 transition-transform duration-200 group-hover:scale-110" />
                                </Button>
                              ) : agent.state === 'RegistrationInitiated' ||
                                agent.state === 'DeregistrationInitiated' ? (
                                <div className="flex items-center justify-center w-8 h-8">
                                  <Spinner size={16} />
                                </div>
                              ) : agent.state === 'RegistrationRequested' ||
                                agent.state === 'DeregistrationRequested' ? (
                                <div className="flex items-center justify-center w-8 h-8">
                                  <FaRegClock size={12} />
                                </div>
                              ) : null}
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            <div className="flex flex-col gap-4 items-center">
              {!(isLoading && !inboxAgents.length) && (
                <Pagination hasMore={hasMore} isLoading={isFetching} onLoadMore={loadMore} />
              )}
            </div>
          </div>

          <RegisterInboxAgentDialog
            open={shouldOpenRegisterDialog}
            onClose={() => {
              setIsRegisterDialogOpen(false);
              if (router.query.action === 'register_inbox_agent') {
                setDismissedQueryAction(true);
                void router.replace('/inbox-agents', undefined, { shallow: true });
              }
            }}
            onSuccess={() => {
              setTimeout(() => {
                refetchAll();
              }, 250);
            }}
          />

          <InboxAgentDetailsDialog
            agent={selectedInboxAgent}
            onClose={() => setSelectedInboxAgent(null)}
            onSuccess={() => {
              setSelectedInboxAgent(null);
              setTimeout(() => {
                refetchAll();
              }, 250);
            }}
          />

          <ConfirmDialog
            open={isDeleteDialogOpen}
            onClose={() => {
              setIsDeleteDialogOpen(false);
              setSelectedInboxAgentToDelete(null);
            }}
            title={
              selectedInboxAgentToDelete?.state === 'RegistrationConfirmed'
                ? `Deregister ${selectedInboxAgentToDelete?.name}`
                : `Delete ${selectedInboxAgentToDelete?.name}`
            }
            description={
              selectedInboxAgentToDelete?.state === 'RegistrationConfirmed'
                ? `Are you sure you want to deregister "${selectedInboxAgentToDelete?.name}"? This will burn the managed inbox registry NFT.`
                : `Are you sure you want to delete "${selectedInboxAgentToDelete?.name}"? This action cannot be undone.`
            }
            onConfirm={() => {
              void handleDeleteConfirm();
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
