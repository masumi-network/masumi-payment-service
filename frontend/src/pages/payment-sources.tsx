/* eslint-disable react-hooks/exhaustive-deps */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { MainLayout } from '@/components/layout/MainLayout';
import { Plus, Search, Trash2, Edit2 } from 'lucide-react';
import { useState, useEffect, useCallback } from 'react';
import { AddPaymentSourceDialog } from '@/components/payment-sources/AddPaymentSourceDialog';
import { PaymentSourceDialog } from '@/components/payment-sources/PaymentSourceDialog';
import Link from 'next/link';
import { useAppContext } from '@/lib/contexts/AppContext';
import {
  getPaymentSourceExtended,
  deletePaymentSourceExtended,
  patchPaymentSourceExtended,
  GetPaymentSourceResponses,
} from '@/lib/api/generated';
import { toast } from 'react-toastify';
import { Checkbox } from '@/components/ui/checkbox';
import { shortenAddress } from '@/lib/utils';
import Head from 'next/head';
import { Spinner } from '@/components/ui/spinner';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Pagination } from '@/components/ui/pagination';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { CopyButton } from '@/components/ui/copy-button';
import { BadgeWithTooltip } from '@/components/ui/badge-with-tooltip';
import { TOOLTIP_TEXTS } from '@/lib/constants/tooltips';
import { handleApiCall } from '@/lib/utils';

interface UpdatePaymentSourceDialogProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
  paymentSourceId: string;
  currentApiKey: string;
}

function UpdatePaymentSourceDialog({
  open,
  onClose,
  onSuccess,
  paymentSourceId,
  currentApiKey,
}: UpdatePaymentSourceDialogProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [apiKey, setApiKey] = useState(currentApiKey);
  const { apiClient } = useAppContext();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    setIsLoading(true);

    const response = await patchPaymentSourceExtended({
      client: apiClient,
      body: {
        id: paymentSourceId,
        PaymentSourceConfig: {
          rpcProviderApiKey: apiKey,
          rpcProvider: 'Blockfrost',
        },
      },
    });

    if (response.error) {
      const error = response.error as { message: string };
      console.error('Error updating payment source:', error);
      toast.error(error.message || 'Failed to update payment source');
      setIsLoading(false);
      return;
    }

    toast.success('Payment source updated successfully');
    onSuccess();
    onClose();
    setIsLoading(false);
  };

  return (
    <Dialog open={open} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Update Payment Source</DialogTitle>
          <DialogDescription>
            Update the Blockfrost API key for this payment source.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <label
              htmlFor="apiKey"
              className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
            >
              Blockfrost API Key
            </label>
            <Input
              id="apiKey"
              type="text"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="Enter Blockfrost API key"
              required
            />
          </div>

          <div className="flex justify-end gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={isLoading}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isLoading}>
              {isLoading ? 'Updating...' : 'Update'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type PaymentSource =
  GetPaymentSourceResponses['200']['data']['PaymentSources'][0] & {
    PaymentSourceConfig?: {
      rpcProviderApiKey: string;
      rpcProvider: 'Blockfrost';
    };
  };

export default function PaymentSourcesPage() {
  const [searchQuery, setSearchQuery] = useState('');
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [selectedSources, setSelectedSources] = useState<string[]>([]);
  const [paymentSources, setPaymentSources] = useState<PaymentSource[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [sourceToDelete, setSourceToDelete] = useState<PaymentSource | null>(
    null,
  );
  const [sourceToUpdate, setSourceToUpdate] = useState<PaymentSource | null>(
    null,
  );
  const [isDeleting, setIsDeleting] = useState(false);
  const {
    apiClient,
    state,
    selectedPaymentSourceId,
    setSelectedPaymentSourceId,
  } = useAppContext();
  const [filteredPaymentSources, setFilteredPaymentSources] = useState<
    PaymentSource[]
  >([]);
  const [hasMore, setHasMore] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [sourceToSelect, setSourceToSelect] = useState<
    PaymentSource | null | undefined
  >(undefined);
  const [selectedPaymentSourceForDetails, setSelectedPaymentSourceForDetails] =
    useState<PaymentSource | null>(null);

  const filterPaymentSources = useCallback(() => {
    let filtered = [...paymentSources];

    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter((source) => {
        const matchAddress =
          source.smartContractAddress?.toLowerCase().includes(query) || false;
        const matchNetwork =
          source.network?.toLowerCase().includes(query) || false;

        return matchAddress || matchNetwork;
      });
    }

    setFilteredPaymentSources(filtered);
  }, [paymentSources, searchQuery]);

  const fetchPaymentSources = async (cursor?: string | null) => {
    if (!cursor) {
      setIsLoading(true);
      setPaymentSources([]);
    } else {
      setIsLoadingMore(true);
    }

    const response = await getPaymentSourceExtended({
      client: apiClient,
      query: {
        take: 10,
        cursorId: cursor || undefined,
      },
    });

    if (response.error) {
      const error = response.error as { message: string };
      console.error('Error fetching payment sources:', error);
      toast.error(error.message || 'Failed to load payment sources');
      if (!cursor) {
        setPaymentSources([]);
      }
      setHasMore(false);
      setIsLoading(false);
      setIsLoadingMore(false);
      return;
    }

    if (response.data?.data?.ExtendedPaymentSources) {
      const filteredSources = response.data.data.ExtendedPaymentSources.filter(
        (source) => source.network === state.network,
      );

      if (cursor) {
        setPaymentSources((prev) => [...prev, ...filteredSources]);
      } else {
        setPaymentSources(filteredSources);
      }

      setHasMore(response.data.data.ExtendedPaymentSources.length === 10);
    } else {
      if (!cursor) {
        setPaymentSources([]);
      }
      setHasMore(false);
    }

    setIsLoading(false);
    setIsLoadingMore(false);
  };

  useEffect(() => {
    fetchPaymentSources();
  }, [state.network]);

  useEffect(() => {
    filterPaymentSources();
  }, [filterPaymentSources, searchQuery]);

  const handleSelectSource = (id: string) => {
    setSelectedSources((prev) =>
      prev.includes(id)
        ? prev.filter((sourceId) => sourceId !== id)
        : [...prev, id],
    );
  };

  const handleSelectAll = () => {
    setSelectedSources(
      selectedSources.length === paymentSources.length
        ? []
        : paymentSources.map((source) => source.id),
    );
  };

  const handleDeleteSource = async () => {
    if (!sourceToDelete) return;

    await handleApiCall(
      () =>
        deletePaymentSourceExtended({
          client: apiClient,
          body: {
            id: sourceToDelete.id,
          },
        }),
      {
        onSuccess: () => {
          toast.success('Payment source deleted successfully');
          fetchPaymentSources();
        },
        onError: (error: any) => {
          console.error('Error deleting payment source:', error);
          toast.error(error.message || 'Failed to delete payment source');
        },
        onFinally: () => {
          setIsDeleting(false);
          setSourceToDelete(null);
        },
        errorMessage: 'Failed to delete payment source',
      },
    );
  };

  const handleLoadMore = () => {
    if (!isLoadingMore && hasMore && paymentSources.length > 0) {
      const lastSource = paymentSources[paymentSources.length - 1];
      fetchPaymentSources(lastSource.id);
    }
  };

  return (
    <MainLayout>
      <Head>
        <title>Payment Sources | Admin Interface</title>
      </Head>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-semibold">Payment Sources</h1>
              <BadgeWithTooltip
                text="?"
                tooltipText={TOOLTIP_TEXTS.PAYMENT_SOURCES}
                variant="outline"
                className="text-xs w-5 h-5 rounded-full p-0 flex items-center justify-center cursor-help"
              />
            </div>
            <p className="text-sm text-muted-foreground">
              Manage your payment sources.{' '}
              <Link
                href="https://docs.masumi.network/technical-documentation/payment-service-api/payment-source"
                target="_blank"
                className="text-primary hover:underline"
              >
                Learn more
              </Link>
            </p>
          </div>
          <Button
            className="flex items-center gap-2 bg-black text-white hover:bg-black/90"
            onClick={() => setIsAddDialogOpen(true)}
          >
            <Plus className="h-4 w-4" />
            Add payment source
          </Button>
        </div>

        <div className="space-y-6">
          <div className="flex items-center justify-between gap-4">
            <div className="relative flex-1">
              <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                placeholder="Search Payment Source"
                value={searchQuery}
                className="max-w-xs pl-10"
                onChange={(e) => setSearchQuery(e.target.value)}
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
                        paymentSources.length > 0 &&
                        selectedSources.length === paymentSources.length
                      }
                      onCheckedChange={handleSelectAll}
                    />
                  </th>
                  <th className="p-4 text-left text-sm font-medium truncate">
                    Contract address
                  </th>
                  <th className="p-4 text-left text-sm font-medium">ID</th>
                  <th className="p-4 text-left text-sm font-medium">Network</th>
                  <th className="p-4 text-left text-sm font-medium">
                    Payment type
                  </th>
                  <th className="p-4 text-left text-sm font-medium truncate">
                    Fee rate
                  </th>
                  <th className="p-4 text-left text-sm font-medium truncate">
                    Created at
                  </th>
                  <th className="p-4 text-left text-sm font-medium">Wallets</th>
                  <th className="w-20 p-4">
                    {' '}
                    {selectedPaymentSourceId === null ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled
                        className="text-green-600 border-green-600"
                      >
                        All Shown
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setSourceToSelect(null)}
                      >
                        Show all
                      </Button>
                    )}
                  </th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr>
                    <td colSpan={9}>
                      <Spinner size={20} addContainer />
                    </td>
                  </tr>
                ) : filteredPaymentSources.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="text-center py-8">
                      No payment sources found
                    </td>
                  </tr>
                ) : (
                  filteredPaymentSources.map((source) => (
                    <tr
                      key={source.id}
                      className="border-b last:border-b-0 cursor-pointer hover:bg-muted/50"
                      onClick={() => setSelectedPaymentSourceForDetails(source)}
                    >
                      <td className="p-4" onClick={(e) => e.stopPropagation()}>
                        <Checkbox
                          checked={selectedSources.includes(source.id)}
                          onCheckedChange={() => handleSelectSource(source.id)}
                        />
                      </td>
                      <td className="p-4">
                        <div className="text-xs text-muted-foreground font-mono truncate max-w-[200px] flex items-center gap-2">
                          {shortenAddress(source.smartContractAddress)}{' '}
                          <CopyButton value={source.smartContractAddress} />
                        </div>
                      </td>
                      <td className="p-4">
                        <div className="text-sm flex items-center gap-2">
                          {shortenAddress(source.id)}
                          <CopyButton value={source.id} />
                        </div>
                      </td>
                      <td className="p-4">
                        <div className="text-sm">{source.network}</div>
                      </td>
                      <td className="p-4">
                        <div className="text-sm">
                          {(source.feeRatePermille / 10).toFixed(1)}%
                        </div>
                      </td>
                      <td className="p-4">
                        <div className="text-xs text-muted-foreground">
                          {new Date(source.createdAt).toLocaleString()}
                        </div>
                      </td>
                      <td className="p-4">
                        <div className="text-xs text-muted-foreground">
                          <span className="block truncate">
                            {source.PurchasingWallets.length} Buying,
                          </span>
                          <span className="block truncate">
                            {source.SellingWallets.length} Selling
                          </span>
                        </div>
                      </td>
                      <td className="p-4" onClick={(e) => e.stopPropagation()}>
                        <div className="flex gap-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setSourceToUpdate(source)}
                            className="text-primary hover:text-primary hover:bg-primary/10"
                          >
                            <Edit2 className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setSourceToDelete(source)}
                            className="text-destructive hover:text-destructive hover:bg-destructive/10"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                          {selectedPaymentSourceId === source.id ? (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled
                              className="text-green-600 border-green-600"
                            >
                              Active
                            </Button>
                          ) : (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setSourceToSelect(source)}
                            >
                              Select
                            </Button>
                          )}
                        </div>
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

        <AddPaymentSourceDialog
          open={isAddDialogOpen}
          onClose={() => setIsAddDialogOpen(false)}
          onSuccess={fetchPaymentSources}
        />

        <UpdatePaymentSourceDialog
          open={!!sourceToUpdate}
          onClose={() => setSourceToUpdate(null)}
          onSuccess={fetchPaymentSources}
          paymentSourceId={sourceToUpdate?.id || ''}
          currentApiKey={
            sourceToUpdate?.PaymentSourceConfig?.rpcProviderApiKey || ''
          }
        />

        <ConfirmDialog
          open={!!sourceToDelete}
          onClose={() => setSourceToDelete(null)}
          title="Delete Payment Source"
          description={`Are you sure you want to delete this payment source? This will also delete all associated wallets and transactions. This action cannot be undone.`}
          onConfirm={handleDeleteSource}
          isLoading={isDeleting}
        />

        <ConfirmDialog
          open={sourceToSelect !== undefined}
          onClose={() => setSourceToSelect(undefined)}
          title="Switch Payment Source"
          description="Switching payment source will update the displayed agents, wallets, and related content. Continue?"
          onConfirm={() => {
            setSelectedPaymentSourceId(sourceToSelect?.id ?? null);
            setSourceToSelect(undefined);
          }}
          isLoading={false}
        />

        <PaymentSourceDialog
          open={!!selectedPaymentSourceForDetails}
          onClose={() => setSelectedPaymentSourceForDetails(null)}
          paymentSource={selectedPaymentSourceForDetails}
        />
      </div>
    </MainLayout>
  );
}
