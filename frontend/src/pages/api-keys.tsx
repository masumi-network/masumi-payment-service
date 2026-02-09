import { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/router';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

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
import { Search, Plus, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { Tabs } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
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
      (key) => key.networkLimit.includes(network) || key.permission === 'Admin',
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
          key.networkLimit?.some((n) => n.toLowerCase().includes(query)) || false;
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
      <div>
        <div className="mb-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-semibold mb-1">API keys</h1>
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
              <Button onClick={() => setIsAddDialogOpen(true)}>
                <Plus className="h-4 w-4" />
                Add API key
              </Button>
            </div>
          </div>
        </div>

        <div className="space-y-6">
          <Tabs
            tabs={tabs}
            activeTab={activeTab}
            onTabChange={(tab) => {
              setActiveTab(tab);
              refetch();
            }}
          />

          <div className="flex justify-between items-center">
            <div className="relative flex-1">
              <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                placeholder="Search by name, key ID, permission, status, network, or usage"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="max-w-xs pl-10"
              />
            </div>
          </div>

          <div className="border rounded-lg">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="pl-4">ID</TableHead>
                  <TableHead>Key</TableHead>
                  <TableHead>Permission</TableHead>
                  <TableHead>Network Limits</TableHead>
                  <TableHead>Usage Limits</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-10"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <ApiKeyTableSkeleton rows={5} />
                ) : filteredApiKeys.length === 0 ? (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                      {searchQuery ? 'No API keys found matching your search' : 'No API keys found'}
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredApiKeys.map((key, index) => (
                    <TableRow key={index}>
                      <TableCell className="pl-4 font-mono text-xs text-muted-foreground">
                        {shortenAddress(key.id)}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-sm text-muted-foreground">
                            {shortenAddress(key.token)}
                          </span>
                          <CopyButton value={key.token} />
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            key.permission === 'Admin'
                              ? 'default'
                              : key.permission === 'ReadAndPay'
                                ? 'secondary'
                                : 'outline'
                          }
                        >
                          {key.permission}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {key.networkLimit.length > 0 ? (
                          <div className="flex gap-1">
                            {key.networkLimit.map((net) => (
                              <Badge key={net} variant="outline" className="font-normal">
                                {net}
                              </Badge>
                            ))}
                          </div>
                        ) : (
                          <span className="text-muted-foreground">Unlimited</span>
                        )}
                      </TableCell>
                      <TableCell className="text-sm">
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
                      <TableCell>
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
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8">
                              <MoreHorizontal className="h-4 w-4" />
                              <span className="sr-only">Actions</span>
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => setKeyToUpdate(key)}>
                              <Pencil className="mr-2 h-4 w-4" />
                              Edit
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              disabled={key.token === apiKey}
                              onClick={() => setKeyToDelete(key)}
                              className="text-destructive focus:text-destructive"
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
    </MainLayout>
  );
}
