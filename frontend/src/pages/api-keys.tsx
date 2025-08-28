import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { MainLayout } from '@/components/layout/MainLayout';
import Head from 'next/head';
import { useAppContext } from '@/lib/contexts/AppContext';
import {
  getApiKey,
  deleteApiKey,
  GetApiKeyResponses,
} from '@/lib/api/generated';
import { toast } from 'react-toastify';
import { handleApiCall } from '@/lib/utils';
import { AddApiKeyDialog } from '@/components/api-keys/AddApiKeyDialog';
import { UpdateApiKeyDialog } from '@/components/api-keys/UpdateApiKeyDialog';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Spinner } from '@/components/ui/spinner';
import { Search } from 'lucide-react';
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
type ApiKey = GetApiKeyResponses['200']['data']['ApiKeys'][0];

export default function ApiKeys() {
  const { apiClient, state } = useAppContext();
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [allApiKeys, setAllApiKeys] = useState<ApiKey[]>([]);
  const [filteredApiKeys, setFilteredApiKeys] = useState<ApiKey[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [keyToUpdate, setKeyToUpdate] = useState<ApiKey | null>(null);
  const [keyToDelete, setKeyToDelete] = useState<ApiKey | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [activeTab, setActiveTab] = useState('All');
  const [hasMore, setHasMore] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  const tabs = [
    { name: 'All', count: null },
    { name: 'Read', count: null },
    { name: 'ReadAndPay', count: null },
    { name: 'Admin', count: null },
  ];

  const filterApiKeys = useCallback(() => {
    let filtered = [...allApiKeys];

    // Filter by network first
    filtered = filtered.filter((key) =>
      key.networkLimit.includes(state.network),
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
  }, [allApiKeys, searchQuery, activeTab, state.network]);

  const fetchApiKeys = useCallback(
    async (cursor?: string | null) => {
      if (!cursor) {
        setIsLoading(true);
        setAllApiKeys([]);
      } else {
        setIsLoadingMore(true);
      }

      const response = await handleApiCall(
        () =>
          getApiKey({
            client: apiClient,
            query: {
              limit: 10,
              cursorToken: cursor || undefined,
            },
          }),
        {
          onError: (error: any) => {
            console.error('Error fetching API keys:', error);
            toast.error(error.message || 'Failed to fetch API keys');
            if (!cursor) {
              setAllApiKeys([]);
            }
            setHasMore(false);
          },
          onFinally: () => {
            setIsLoading(false);
            setIsLoadingMore(false);
          },
          errorMessage: 'Failed to fetch API keys',
        },
      );

      if (!response) return;

      if (response?.data?.data?.ApiKeys) {
        const newKeys = response.data.data.ApiKeys;

        if (cursor) {
          setAllApiKeys((prev) => {
            // Create a map of existing keys by token to prevent duplicates
            const existingKeysMap = new Map(
              prev.map((key) => [key.token, key]),
            );

            // Add new keys, overwriting any existing ones with the same token
            newKeys.forEach((key) => {
              existingKeysMap.set(key.token, key);
            });

            const combinedKeys = Array.from(existingKeysMap.values());

            // Check if we need to fetch more
            const filteredCount = combinedKeys.filter((key) =>
              key.networkLimit.includes(state.network),
            ).length;

            if (newKeys.length === 10 && filteredCount < 10) {
              const lastKey = newKeys[newKeys.length - 1];
              fetchApiKeys(lastKey.token);
            }

            return combinedKeys;
          });
        } else {
          setAllApiKeys(newKeys);
          // Check if we need to fetch more for initial load
          const filteredCount = newKeys.filter((key) =>
            key.networkLimit.includes(state.network),
          ).length;

          if (newKeys.length === 10 && filteredCount < 10) {
            const lastKey = newKeys[newKeys.length - 1];
            fetchApiKeys(lastKey.token);
          }
        }

        setHasMore(newKeys.length === 10);
      } else {
        if (!cursor) {
          setAllApiKeys([]);
        }
        setHasMore(false);
      }

      setIsLoading(false);
      setIsLoadingMore(false);
    },
    [apiClient, state.network],
  );

  // Separate effect for initial load
  useEffect(() => {
    fetchApiKeys();
  }, [fetchApiKeys]);

  // Separate effect for network changes
  useEffect(() => {
    if (state.network) {
      fetchApiKeys();
    }
  }, [state.network, fetchApiKeys]);

  useEffect(() => {
    filterApiKeys();
  }, [filterApiKeys, searchQuery, activeTab]);

  const handleLoadMore = () => {
    if (!isLoadingMore && hasMore && allApiKeys.length > 0) {
      const lastKey = allApiKeys[allApiKeys.length - 1];
      fetchApiKeys(lastKey.token);
    }
  };

  const handleSelectKey = (token: string) => {
    setSelectedKeys((prev) =>
      prev.includes(token) ? prev.filter((k) => k !== token) : [...prev, token],
    );
  };

  const handleSelectAll = () => {
    setSelectedKeys(
      selectedKeys.length === allApiKeys.length
        ? []
        : allApiKeys.map((key) => key.token),
    );
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
          fetchApiKeys();
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
          <h1 className="text-xl font-semibold mb-1">API keys</h1>
          <p className="text-sm text-muted-foreground">
            Manage your API keys for accessing the payment service.{' '}
            <a
              href="https://docs.masumi.network/technical-documentation/payment-service-api/api-keys"
              target="_blank"
              className="text-primary hover:underline"
            >
              Learn more
            </a>
          </p>
        </div>

        <div className="space-y-6">
          <Tabs
            tabs={tabs}
            activeTab={activeTab}
            onTabChange={(tab) => {
              setActiveTab(tab);
              setAllApiKeys([]);
              fetchApiKeys();
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
            <div className="flex items-center gap-2">
              <Button onClick={() => setIsAddDialogOpen(true)}>
                Add API key
              </Button>
            </div>
          </div>

          <div className="border rounded-lg overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b">
                  <th className="w-12 p-4">
                    <Checkbox
                      checked={
                        allApiKeys.length > 0 &&
                        selectedKeys.length === allApiKeys.length
                      }
                      onCheckedChange={handleSelectAll}
                    />
                  </th>
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
                  <tr>
                    <td colSpan={8}>
                      <Spinner size={20} addContainer />
                    </td>
                  </tr>
                ) : filteredApiKeys.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="text-center py-8">
                      {searchQuery
                        ? 'No API keys found matching your search'
                        : 'No API keys found'}
                    </td>
                  </tr>
                ) : (
                  filteredApiKeys.map((key, index) => (
                    <tr key={index} className="border-b" onClick={() => {}}>
                      <td className="p-4">
                        <Checkbox
                          checked={selectedKeys.includes(key.token)}
                          onCheckedChange={() => handleSelectKey(key.token)}
                        />
                      </td>
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
                          className={`inline-flex items-center rounded-full px-2 py-1 text-xs ${
                            key.status === 'Active'
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
                            <SelectItem value="delete" className="text-red-600">
                              Delete
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
                isLoading={isLoadingMore}
                onLoadMore={handleLoadMore}
              />
            )}
          </div>
        </div>
      </div>

      <AddApiKeyDialog
        open={isAddDialogOpen}
        onClose={() => setIsAddDialogOpen(false)}
        onSuccess={fetchApiKeys}
      />

      {keyToUpdate && (
        <UpdateApiKeyDialog
          open={true}
          onClose={() => setKeyToUpdate(null)}
          onSuccess={fetchApiKeys}
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
