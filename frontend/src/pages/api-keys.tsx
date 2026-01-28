/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, useEffect, useCallback } from 'react';
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
import { Search, Plus } from 'lucide-react';
import { Tabs } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Pagination } from '@/components/ui/pagination';
import { CopyButton } from '@/components/ui/copy-button';
import { shortenAddress } from '@/lib/utils';
import { useApiKey } from '@/lib/hooks/useApiKey';
import { ApiKey } from '@/lib/api/generated';

export default function ApiKeys() {
  const router = useRouter();
  const { apiClient, network, apiKey } = useAppContext();

  const [filteredApiKeys, setFilteredApiKeys] = useState<ApiKey[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [keyToUpdate, setKeyToUpdate] = useState<ApiKey | null>(null);
  const [keyToDelete, setKeyToDelete] = useState<ApiKey | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [activeTab, setActiveTab] = useState('All');
  const { allApiKeys, isLoading, hasMore, loadMore, refetch } = useApiKey();

  const tabs = [
    { name: 'All', count: null },
    { name: 'Read', count: null },
    { name: 'ReadAndPay', count: null },
    { name: 'Admin', count: null },
  ];

  const filterApiKeys = useCallback(() => {
    let filtered = [...allApiKeys];

    // Filter by network first
    filtered = filtered.filter(
      (key) => key.networkLimit.includes(network) || key.permission === 'Admin',
    );

    // Then filter by permission tab
    if (activeTab === 'Read') {
      filtered = filtered.filter((key) => key.permission === 'Read');
    } else if (activeTab === 'ReadAndPay') {
      filtered = filtered.filter((key) => key.permission === 'ReadAndPay');
    } else if (activeTab === 'Admin') {
      filtered = filtered.filter((key) => key.permission === 'Admin');
    }

    // Then filter by search query
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter((key) => {
        const nameMatch = key.id?.toLowerCase().includes(query) || false;
        const tokenMatch = key.token?.toLowerCase().includes(query) || false;
        const permissionMatch =
          key.permission?.toLowerCase().includes(query) || false;
        const statusMatch = key.status?.toLowerCase().includes(query) || false;
        const networkMatch =
          key.networkLimit?.some((network) =>
            network.toLowerCase().includes(query),
          ) || false;

        return (
          nameMatch ||
          tokenMatch ||
          permissionMatch ||
          statusMatch ||
          networkMatch
        );
      });
    }

    setFilteredApiKeys(filtered);
  }, [allApiKeys, searchQuery, activeTab, network]);

  useEffect(() => {
    filterApiKeys();
  }, [filterApiKeys, searchQuery, activeTab]);

  // Handle action query parameter from search
  useEffect(() => {
    if (router.query.action === 'add_api_key') {
      setIsAddDialogOpen(true);
      // Clean up the query parameter
      router.replace('/api-keys', undefined, { shallow: true });
    }
  }, [router.query.action, router]);

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

          <div className="border rounded-lg overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b">

                  <th className="p-4 text-left text-sm font-medium">ID</th>
                  <th className="p-4 text-left text-sm font-medium">Key</th>
                  <th className="p-4 text-left text-sm font-medium">
                    Permission
                  </th>
                  <th className="p-4 text-left text-sm font-medium">
                    Networks
                  </th>
                  <th className="p-4 text-left text-sm font-medium">
                    Usage Limits
                  </th>
                  <th className="p-4 text-left text-sm font-medium">Status</th>
                  <th className="w-12 p-4"></th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <ApiKeyTableSkeleton rows={5} />
                ) : filteredApiKeys.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="text-center py-8">
                      {searchQuery
                        ? 'No API keys found matching your search'
                        : 'No API keys found'}
                    </td>
                  </tr>
                ) : (
                  filteredApiKeys.map((key, index) => (
                    <tr key={index} className="border-b" onClick={() => { }}>

                      <td className="p-4">
                        <div className="text-sm">{key.id}</div>
                      </td>
                      <td className="p-4 truncate">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-sm text-muted-foreground">
                            {shortenAddress(key.token)}
                          </span>
                          <CopyButton value={key.token} />
                        </div>
                      </td>
                      <td className="p-4 text-sm">{key.permission}</td>
                      <td className="p-4 text-sm">
                        <div className="flex gap-1">
                          {key.networkLimit.map((network) => (
                            <span
                              key={network}
                              className="inline-flex items-center rounded-full bg-gray-100 dark:bg-gray-100/10 px-2 py-1 text-xs"
                            >
                              {network}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="p-4 text-sm">
                        {key.usageLimited ? (
                          <div className="space-y-1">
                            {key.RemainingUsageCredits.map((credit, index) => (
                              <div key={index}>
                                {credit.unit === 'lovelace'
                                  ? `${(Number(credit.amount) / 1000000).toLocaleString()} ADA`
                                  : `${credit.amount} ${credit.unit}`}
                              </div>
                            ))}
                          </div>
                        ) : (
                          'Unlimited'
                        )}
                      </td>
                      <td className="p-4 text-sm">
                        <span
                          className={`inline-flex items-center rounded-full px-2 py-1 text-xs ${key.status === 'Active'
                              ? 'bg-green-100 text-green-700'
                              : 'bg-red-100 text-red-700'
                            }`}
                        >
                          {key.status}
                        </span>
                      </td>
                      <td className="p-4">
                        <Select
                          onValueChange={(value) => {
                            if (value === 'update') {
                              setKeyToUpdate(key);
                            } else if (value === 'delete') {
                              setKeyToDelete(key);
                            }
                          }}
                          value=""
                        >
                          <SelectTrigger className="w-[100px]">
                            <SelectValue placeholder="Actions" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="update">Update</SelectItem>
                            <SelectItem
                              disabled={key.token === apiKey}
                              value="delete"
                              className="text-red-600"
                            >
                              {key.token === apiKey
                                ? 'Cannot delete current API key'
                                : 'Delete'}
                            </SelectItem>
                          </SelectContent>
                        </Select>
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
                isLoading={isLoading}
                onLoadMore={handleLoadMore}
              />
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
