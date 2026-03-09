import { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/router';
import { Button } from '@/components/ui/button';

import { MainLayout } from '@/components/layout/MainLayout';
import { RefreshButton } from '@/components/RefreshButton';
import Head from 'next/head';
import { useAppContext } from '@/lib/contexts/AppContext';
import { deleteApiKey } from '@/lib/api/generated';
import { toast } from 'react-toastify';
import { handleApiCall } from '@/lib/utils';
import { AddApiKeyDialog } from '@/components/api-keys/AddApiKeyDialog';
import { UpdateApiKeyDialog } from '@/components/api-keys/UpdateApiKeyDialog';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { ApiKeyTableSkeleton } from '@/components/skeletons/ApiKeyTableSkeleton';
import { Plus, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { Tabs } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { AnimatedPage } from '@/components/ui/animated-page';
import { SearchInput } from '@/components/ui/search-input';
import { EmptyState } from '@/components/ui/empty-state';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Pagination } from '@/components/ui/pagination';
import { CopyButton } from '@/components/ui/copy-button';
import { shortenAddress } from '@/lib/utils';
import { useApiKey } from '@/lib/hooks/useApiKey';
import { ApiKey } from '@/lib/api/generated';

export default function ApiKeys() {
  const router = useRouter();
  const { apiClient, network, apiKey } = useAppContext();

  const [searchQuery, setSearchQuery] = useState('');
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [keyToUpdate, setKeyToUpdate] = useState<ApiKey | null>(null);
  const [keyToDelete, setKeyToDelete] = useState<ApiKey | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [activeTab, setActiveTab] = useState('All');
  const { allApiKeys, isLoading, hasMore, loadMore, refetch } = useApiKey();

  const filteredApiKeys = useMemo(() => {
    let filtered = [...allApiKeys];
    filtered = filtered.filter(
      (key) => key.NetworkLimit.includes(network) || key.permission === 'Admin',
    );
    if (activeTab === 'Read') {
      filtered = filtered.filter((key) => key.permission === 'Read');
    } else if (activeTab === 'ReadAndPay') {
      filtered = filtered.filter((key) => key.permission === 'ReadAndPay');
    } else if (activeTab === 'Admin') {
      filtered = filtered.filter((key) => key.permission === 'Admin');
    }
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter((key) => {
        const nameMatch = key.id?.toLowerCase().includes(query) || false;
        const tokenMatch = key.token?.toLowerCase().includes(query) || false;
        const permissionMatch = key.permission?.toLowerCase().includes(query) || false;
        const statusMatch = key.status?.toLowerCase().includes(query) || false;
        const networkMatch =
          key.NetworkLimit?.some((n) => n.toLowerCase().includes(query)) || false;
        return nameMatch || tokenMatch || permissionMatch || statusMatch || networkMatch;
      });
    }
    return filtered;
  }, [allApiKeys, searchQuery, activeTab, network]);

  useEffect(() => {
    if (router.query.action === 'add_api_key') {
      queueMicrotask(() => setIsAddDialogOpen(true));
      router.replace('/api-keys', undefined, { shallow: true });
    }
  }, [router.query.action, router]);

  const tabs = [
    { name: 'All', count: null },
    { name: 'Read', count: null },
    { name: 'ReadAndPay', count: null },
    { name: 'Admin', count: null },
  ];

  const handleLoadMore = () => {
    loadMore();
  };

  const handleDeleteApiKey = async () => {
    if (!keyToDelete || !keyToDelete.id) return;

    await handleApiCall(
      () =>
        deleteApiKey({
          client: apiClient,
          body: {
            id: keyToDelete.id,
          },
        }),
      {
        onSuccess: () => {
          toast.success('API key deleted successfully');
          refetch();
        },
        onError: (error: any) => {
          console.error('Error deleting API key:', error);
          toast.error(error.message || 'Failed to delete API key');
        },
        onFinally: () => {
          setIsDeleting(false);
          setKeyToDelete(null);
        },
        errorMessage: 'Failed to delete API key',
      },
    );
  };

  return (
    <MainLayout>
      <Head>
        <title>API Keys | Admin Interface</title>
      </Head>
      <AnimatedPage>
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">API keys</h1>
              <p className="text-sm text-muted-foreground">
                Manage your API keys for accessing the payment service.{' '}
                <a
                  href="https://docs.masumi.network/api-reference"
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
                  refetch();
                }}
                isRefreshing={isLoading}
              />
              <Button className="btn-hover-lift" onClick={() => setIsAddDialogOpen(true)}>
                <Plus className="h-4 w-4" />
                Add API key
              </Button>
            </div>
          </div>
          <Tabs
            tabs={tabs}
            activeTab={activeTab}
            onTabChange={(tab) => {
              setActiveTab(tab);
              refetch();
            }}
          />

          <div className="flex justify-between items-center">
            <div className="flex-1">
              <SearchInput
                value={searchQuery}
                onChange={setSearchQuery}
                placeholder="Search by name, key ID, permission, status, network, or usage"
                className="max-w-xs"
              />
            </div>
          </div>

          <div className="border rounded-lg">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="p-4 pl-6">ID</TableHead>
                  <TableHead className="p-4">Key</TableHead>
                  <TableHead className="p-4">Permission</TableHead>
                  <TableHead className="p-4">Network Limits</TableHead>
                  <TableHead className="p-4">Usage Limits</TableHead>
                  <TableHead className="p-4">Wallet Scope</TableHead>
                  <TableHead className="p-4">Status</TableHead>
                  <TableHead className="w-10 p-4"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <ApiKeyTableSkeleton rows={5} />
                ) : filteredApiKeys.length === 0 ? (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={8}>
                      <EmptyState
                        icon={searchQuery ? 'search' : 'inbox'}
                        title={
                          searchQuery
                            ? 'No API keys found matching your search'
                            : 'No API keys found'
                        }
                        description={
                          searchQuery
                            ? 'Try adjusting your search terms'
                            : 'Add an API key to get started'
                        }
                      />
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredApiKeys.map((key, index) => (
                    <TableRow
                      key={index}
                      className="animate-fade-in opacity-0"
                      style={{ animationDelay: `${Math.min(index, 9) * 40}ms` }}
                    >
                      <TableCell className="p-4 pl-6 font-mono text-xs text-muted-foreground">
                        {shortenAddress(key.id)}
                      </TableCell>
                      <TableCell className="p-4">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-sm text-muted-foreground">
                            {shortenAddress(key.token)}
                          </span>
                          <CopyButton value={key.token} />
                        </div>
                      </TableCell>
                      <TableCell className="p-4">
                        <Badge
                          variant={
                            key.permission === 'Admin'
                              ? 'default'
                              : key.permission === 'ReadAndPay'
                                ? 'secondary'
                                : 'outline'
                          }
                          className={
                            key.permission === 'Admin'
                              ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400 hover:bg-amber-100/80 dark:hover:bg-amber-900/40'
                              : ''
                          }
                        >
                          {key.permission}
                        </Badge>
                      </TableCell>
                      <TableCell className="p-4">
                        {key.NetworkLimit.length > 0 ? (
                          <div className="flex gap-1">
                            {key.NetworkLimit.map((net) => (
                              <Badge key={net} variant="outline" className="font-normal">
                                {net}
                              </Badge>
                            ))}
                          </div>
                        ) : (
                          <span className="text-muted-foreground">Unlimited</span>
                        )}
                      </TableCell>
                      <TableCell className="p-4 text-sm">
                        {key.usageLimited ? (
                          <div className="space-y-0.5">
                            {key.RemainingUsageCredits.map((credit, i) => (
                              <div key={i} className="text-muted-foreground">
                                {credit.unit === 'lovelace'
                                  ? `${(Number(credit.amount) / 1000000).toLocaleString()} ADA`
                                  : `${credit.amount} ${credit.unit}`}
                              </div>
                            ))}
                          </div>
                        ) : (
                          <span className="text-muted-foreground">Unlimited</span>
                        )}
                      </TableCell>
                      <TableCell className="p-4 text-sm">
                        {key.walletScopeEnabled ? (
                          <Badge
                            variant="secondary"
                            className="bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400 hover:bg-blue-100/80 dark:hover:bg-blue-900/40"
                          >
                            {key.WalletScopes.length} wallet
                            {key.WalletScopes.length !== 1 ? 's' : ''}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">All</span>
                        )}
                      </TableCell>
                      <TableCell className="p-4">
                        <Badge
                          variant={key.status === 'Active' ? 'default' : 'destructive'}
                          className={
                            key.status === 'Active'
                              ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 hover:bg-green-100 dark:hover:bg-green-900/30'
                              : ''
                          }
                        >
                          {key.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="p-4">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8">
                              <MoreHorizontal className="h-4 w-4" />
                              <span className="sr-only">Actions</span>
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="min-w-[120px]">
                            <DropdownMenuItem
                              onClick={() => setKeyToUpdate(key)}
                              className="whitespace-nowrap"
                            >
                              <Pencil className="mr-2 h-4 w-4 shrink-0" />
                              Edit
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              disabled={key.token === apiKey}
                              onClick={() => setKeyToDelete(key)}
                              className="whitespace-nowrap text-destructive focus:text-destructive"
                            >
                              <Trash2 className="mr-2 h-4 w-4 shrink-0" />
                              <span>{key.token === apiKey ? 'In use' : 'Delete'}</span>
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          <div className="flex flex-col gap-4 items-center">
            {!isLoading && (
              <Pagination hasMore={hasMore} isLoading={isLoading} onLoadMore={handleLoadMore} />
            )}
          </div>
        </div>

        <AddApiKeyDialog
          open={isAddDialogOpen}
          onClose={() => setIsAddDialogOpen(false)}
          onSuccess={() => {
            refetch();
          }}
        />

        {keyToUpdate && (
          <UpdateApiKeyDialog
            open={true}
            onClose={() => setKeyToUpdate(null)}
            onSuccess={() => {
              refetch();
            }}
            apiKey={keyToUpdate}
          />
        )}

        <ConfirmDialog
          open={!!keyToDelete}
          onClose={() => setKeyToDelete(null)}
          title="Delete API Key"
          description="Are you sure you want to delete this API key? This action cannot be undone."
          onConfirm={handleDeleteApiKey}
          isLoading={isDeleting}
        />
      </AnimatedPage>
    </MainLayout>
  );
}
