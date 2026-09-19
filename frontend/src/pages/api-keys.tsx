import { useState, useEffect, useMemo, useRef } from 'react';
import { useRouter } from 'next/router';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { BulkActionBar } from '@/components/ui/bulk-action-bar';
import {
  TableSelectAllCheckbox,
  TableSelectRowCheckbox,
} from '@/components/ui/table-select-checkbox';
import { MainLayout } from '@/components/layout/MainLayout';
import { RefreshButton } from '@/components/RefreshButton';
import Head from 'next/head';
import { useAppContext } from '@/lib/contexts/AppContext';
import { deleteApiKey } from '@/lib/api/generated';
import { toast } from 'react-toastify';
import { cn, formatAssetAmount } from '@/lib/utils';
import { useApiMutation } from '@/lib/hooks/useApiMutation';
import { AddApiKeyDialog } from '@/components/api-keys/AddApiKeyDialog';
import { UpdateApiKeyDialog } from '@/components/api-keys/UpdateApiKeyDialog';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { HorizontalScrollArea } from '@/components/ui/horizontal-scroll-area';
import {
  tableActionsCellCompactClass,
  tableActionsCellCompactSelectedClass,
  tableActionsHeadCompactClass,
  tableActionsInnerClass,
} from '@/components/ui/table-actions-column';
import { ApiKeyTableSkeleton } from '@/components/skeletons/ApiKeyTableSkeleton';
import { MoreHorizontal, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { Tabs } from '@/components/ui/tabs';
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
import {
  BULK_ACTION_MAX_ITEMS,
  runBulkSequential,
  useTableSelection,
} from '@/lib/hooks/useTableSelection';
import { ApiKey } from '@/lib/api/generated';

/**
 * Get a human-readable permission label from flags.
 */
function getPermissionLabel(apiKey: ApiKey): string {
  if (apiKey.canAdmin) return 'Admin';
  if (apiKey.canPay) return 'Read and Pay';
  return 'Read Only';
}

/**
 * Check if an API key matches a permission tab filter.
 */
function matchesPermissionTab(apiKey: ApiKey, tab: string): boolean {
  switch (tab) {
    case 'Read':
      return apiKey.canRead && !apiKey.canPay && !apiKey.canAdmin;
    case 'Read and Pay':
      return apiKey.canPay && !apiKey.canAdmin;
    case 'Admin':
      return apiKey.canAdmin;
    case 'All':
    default:
      return true;
  }
}

function isRedactedApiKeyToken(token: string): boolean {
  return token.startsWith('*****');
}

/**
 * Whether a listed key is the one this session is signed in with.
 *
 * GET /api-key never returns a plaintext token: it masks it as
 * `'*****' + token.slice(-4)` (src/routes/api/api-key/index.ts). Comparing that
 * mask to the session's plaintext key is therefore always false, which silently
 * disabled the "cannot delete the key you are signed in with" guard and let an
 * operator lock themselves out of the dashboard in one click. Mask the session key
 * the same way instead. Two keys sharing a last-four collide and both get guarded,
 * which is the safe direction to be wrong in.
 */
function isSessionApiKey(listedToken: string, sessionApiKey: string | null): boolean {
  if (!sessionApiKey) return false;
  if (listedToken === sessionApiKey) return true;
  return listedToken === `*****${sessionApiKey.slice(-4)}`;
}

export default function ApiKeys() {
  const router = useRouter();
  const { apiClient, network, apiKey } = useAppContext();
  const [searchQuery, setSearchQuery] = useState('');
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [keyToUpdate, setKeyToUpdate] = useState<ApiKey | null>(null);
  const [keyToDelete, setKeyToDelete] = useState<ApiKey | null>(null);
  const [isBulkDeleteConfirmOpen, setIsBulkDeleteConfirmOpen] = useState(false);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);
  const deleteKeyMutation = useApiMutation({
    mutationFn: (body: { id: string }) => deleteApiKey({ client: apiClient, body }),
    errorMessage: 'Failed to delete API key',
  });
  const isDeleting = deleteKeyMutation.isPending;
  // Synchronous in-flight guard for delete. `setIsDeleting(true)` is async, so
  // a fast double-click on Confirm fires `handleDeleteApiKey` twice before the
  // button disables — sending two DELETEs for the same id. A ref flips
  // synchronously on the first call so the duplicate is rejected immediately;
  // `isDeleting` on the button is post-render defence-in-depth.
  const isDeletingRef = useRef(false);
  const [activeTab, setActiveTab] = useState('All');
  const { allApiKeys, isLoading, isRefetching, hasMore, loadMore, refetch, reset } = useApiKey();

  const tabs = [
    { name: 'All', count: null },
    { name: 'Read', count: null },
    { name: 'Read and Pay', count: null },
    { name: 'Admin', count: null },
  ];

  // Derive filtered API keys from state (no setState in effect needed)
  const filteredApiKeys = useMemo(() => {
    let filtered = [...allApiKeys];

    // Filter by network first (admin keys have access to all networks)
    filtered = filtered.filter((key) => key.NetworkLimit.includes(network) || key.canAdmin);

    // Then filter by permission tab using flag-based logic
    filtered = filtered.filter((key) => matchesPermissionTab(key, activeTab));

    // Then filter by search query
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter((key) => {
        const nameMatch = key.id?.toLowerCase().includes(query) || false;
        const tokenMatch = key.token?.toLowerCase().includes(query) || false;
        const permissionMatch = getPermissionLabel(key).toLowerCase().includes(query) || false;
        const statusMatch = key.status?.toLowerCase().includes(query) || false;
        const networkMatch =
          key.NetworkLimit?.some((n) => n.toLowerCase().includes(query)) || false;

        return nameMatch || tokenMatch || permissionMatch || statusMatch || networkMatch;
      });
    }

    return filtered;
  }, [allApiKeys, searchQuery, activeTab, network]);

  const visibleRowIds = useMemo(
    () => filteredApiKeys.map((key) => key.id).filter((id): id is string => Boolean(id)),
    [filteredApiKeys],
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

  const selectedApiKeys = useMemo(
    () => filteredApiKeys.filter((key) => selectedIds.has(key.id)),
    [filteredApiKeys, selectedIds],
  );

  const bulkDeletableKeys = useMemo(
    () => selectedApiKeys.filter((key) => !isSessionApiKey(key.token, apiKey)),
    [selectedApiKeys, apiKey],
  );

  // Handle action query parameter from search. Stripping the param (rather
  // than latching a once-per-mount flag) lets the same quick action fire
  // again while already on this page.
  useEffect(() => {
    if (router.query.action === 'add_api_key') {
      // Use queueMicrotask to avoid synchronous setState within the effect
      queueMicrotask(() => {
        setIsAddDialogOpen(true);
      });
      // Clean up the query parameter
      router.replace('/api-keys', undefined, { shallow: true });
    }
  }, [router.query.action, router]);

  const handleLoadMore = () => {
    loadMore();
  };

  const handleDeleteApiKey = async () => {
    if (!keyToDelete || !keyToDelete.id) return;
    if (isDeletingRef.current) return;
    isDeletingRef.current = true;

    try {
      const response = await deleteKeyMutation
        .mutateAsync({ id: keyToDelete.id })
        .catch((error: unknown) => {
          console.error('Error deleting API key:', error);
          return null;
        });
      setKeyToDelete(null);
      if (response) {
        toast.success('API key deleted successfully');
        void reset();
      }
    } finally {
      isDeletingRef.current = false;
    }
  };

  const handleBulkDeleteApiKeys = async () => {
    const ids = bulkDeletableKeys.map((key) => key.id);
    if (ids.length === 0) return;
    if (isDeletingRef.current) return;
    isDeletingRef.current = true;
    setIsBulkDeleting(true);

    try {
      const { succeeded, failed, failedIds, skippedLimit } = await runBulkSequential(
        ids,
        async (id) => {
          const response = await deleteKeyMutation.mutateAsync({ id }).catch((error: unknown) => {
            console.error('Error deleting API key:', error);
            return null;
          });
          return Boolean(response);
        },
      );

      setIsBulkDeleteConfirmOpen(false);

      if (skippedLimit) {
        toast.error(`Select at most ${BULK_ACTION_MAX_ITEMS} keys at a time`);
        return;
      }

      if (succeeded > 0) {
        toast.success(`Deleted ${succeeded} API key${succeeded === 1 ? '' : 's'} successfully`);
        void reset();
      }
      if (failed > 0) {
        toast.error(`Failed to delete ${failed} API key${failed === 1 ? '' : 's'}`);
      }

      setSelectionToIds(failedIds);
    } finally {
      isDeletingRef.current = false;
      setIsBulkDeleting(false);
    }
  };

  const openBulkDeleteConfirm = () => {
    if (bulkDeletableKeys.length === 0) {
      toast.error('The current session key cannot be bulk-deleted. Deselect it and try again.');
      return;
    }
    if (selectedApiKeys.length > bulkDeletableKeys.length) {
      toast.info('Your current session key will be skipped.');
    }
    setIsBulkDeleteConfirmOpen(true);
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
                  href="https://www.masumi.network/dev/masumi/api-reference"
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
                  refetch();
                }}
                isRefreshing={isRefetching}
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
              clearSelection();
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
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  clearSelection();
                }}
                className="max-w-xs pl-10"
              />
            </div>
          </div>

          <BulkActionBar
            selectedCount={selectedCount}
            onClear={clearSelection}
            disabled={isBulkDeleting || isDeleting}
          >
            <Button
              variant="destructive"
              size="sm"
              onClick={openBulkDeleteConfirm}
              disabled={isBulkDeleting || isDeleting || bulkDeletableKeys.length === 0}
            >
              <Trash2 className="h-4 w-4" />
              Delete ({bulkDeletableKeys.length})
            </Button>
          </BulkActionBar>

          <HorizontalScrollArea className="border rounded-lg">
            <table className="w-full">
              <thead className="table-header-surface">
                <tr className="border-b">
                  <th className="w-12 p-4">
                    <TableSelectAllCheckbox
                      allSelected={allSelected}
                      someSelected={someSelected}
                      onToggleAll={toggleAll}
                      disabled={filteredApiKeys.length === 0}
                      aria-label="Select all API keys on this page"
                    />
                  </th>
                  <th className="p-4 text-left text-sm font-medium">Key</th>
                  <th className="p-4 text-left text-sm font-medium">Permission</th>
                  <th className="p-4 text-left text-sm font-medium">Networks</th>
                  <th className="p-4 text-left text-sm font-medium">Usage Limits</th>
                  <th className="p-4 text-left text-sm font-medium">Status</th>
                  <th className={tableActionsHeadCompactClass}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <ApiKeyTableSkeleton rows={5} />
                ) : filteredApiKeys.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="text-center py-8">
                      {searchQuery ? 'No API keys found matching your search' : 'No API keys found'}
                    </td>
                  </tr>
                ) : (
                  filteredApiKeys.map((key) => {
                    const isCurrentKey = isSessionApiKey(key.token, apiKey);
                    const isKeySelected = isSelected(key.id);
                    return (
                      <tr
                        key={key.id}
                        className={cn(
                          'group border-b transition-[background-color] duration-150 hover:bg-row-hover',
                          isKeySelected && 'bg-row-hover',
                        )}
                      >
                        <td className="p-4" onClick={(event) => event.stopPropagation()}>
                          <TableSelectRowCheckbox
                            aria-label={`Select key ${key.token}`}
                            checked={isKeySelected}
                            onToggle={() => toggleRow(key.id)}
                          />
                        </td>
                        <td className="p-4 truncate">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono text-sm text-muted-foreground">
                              {/* A masked token is already short; running it through
                                shortenAddress elided the only four characters that
                                identify it. */}
                              {isRedactedApiKeyToken(key.token)
                                ? key.token
                                : shortenAddress(key.token)}
                            </span>
                            {!isRedactedApiKeyToken(key.token) && <CopyButton value={key.token} />}
                            {isCurrentKey && (
                              <Badge
                                variant="secondary"
                                className="font-normal shrink-0"
                                title="Signed in with this API key"
                              >
                                Current key
                              </Badge>
                            )}
                          </div>
                        </td>
                        <td className="p-4 text-sm">{getPermissionLabel(key)}</td>
                        <td className="p-4 text-sm">
                          <div className="flex gap-1">
                            {key.NetworkLimit.map((network) => (
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
                                  {formatAssetAmount(credit.amount, credit.unit, network)}
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
                                ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                                : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                            }`}
                          >
                            {key.status}
                          </span>
                        </td>
                        <td
                          className={
                            isKeySelected
                              ? tableActionsCellCompactSelectedClass
                              : tableActionsCellCompactClass
                          }
                        >
                          <div className={tableActionsInnerClass}>
                            <DropdownMenu modal={false}>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  aria-label="API key actions"
                                  className="h-8 w-8"
                                  onClick={(event) => event.stopPropagation()}
                                >
                                  <MoreHorizontal className="h-4 w-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent
                                align="end"
                                onClick={(event) => event.stopPropagation()}
                              >
                                <DropdownMenuItem
                                  className="cursor-pointer gap-2"
                                  onSelect={() => setKeyToUpdate(key)}
                                >
                                  <Pencil className="h-4 w-4" />
                                  Update
                                </DropdownMenuItem>
                                {!isCurrentKey && (
                                  <>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem
                                      className="cursor-pointer gap-2 text-destructive focus:text-destructive"
                                      onSelect={() => setKeyToDelete(key)}
                                    >
                                      <Trash2 className="h-4 w-4" />
                                      Delete
                                    </DropdownMenuItem>
                                  </>
                                )}
                              </DropdownMenuContent>
                            </DropdownMenu>
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

      <ConfirmDialog
        open={isBulkDeleteConfirmOpen}
        onClose={() => setIsBulkDeleteConfirmOpen(false)}
        title="Delete API keys"
        description={`Delete ${bulkDeletableKeys.length} API key${bulkDeletableKeys.length === 1 ? '' : 's'}? This action cannot be undone.`}
        onConfirm={() => void handleBulkDeleteApiKeys()}
        isLoading={isBulkDeleting}
      />
    </MainLayout>
  );
}
