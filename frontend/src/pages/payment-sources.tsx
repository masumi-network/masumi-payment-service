import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { MainLayout } from '@/components/layout/MainLayout';
import { Plus, Search, Trash2, Edit2 } from 'lucide-react';
import { RefreshButton } from '@/components/RefreshButton';
import { useState, useEffect, useCallback } from 'react';
import { AddPaymentSourceDialog } from '@/components/payment-sources/AddPaymentSourceDialog';
import { PaymentSourceDialog } from '@/components/payment-sources/PaymentSourceDialog';
import Link from 'next/link';
import { useAppContext } from '@/lib/contexts/AppContext';
import {
  deletePaymentSourceExtended,
  patchPaymentSourceExtended,
  PaymentSourceExtended,
} from '@/lib/api/generated';
import { toast } from 'react-toastify';

import { shortenAddress } from '@/lib/utils';
import Head from 'next/head';
import { PaymentSourceTableSkeleton } from '@/components/skeletons/PaymentSourceTableSkeleton';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
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
import { useRouter } from 'next/router';
import { usePaymentSourceExtendedAll } from '@/lib/hooks/usePaymentSourceExtendedAll';

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
            <Button type="button" variant="outline" onClick={onClose} disabled={isLoading}>
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

export default function PaymentSourcesPage() {
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState('');
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);

  const [sourceToDelete, setSourceToDelete] = useState<PaymentSourceExtended | null>(null);
  const [sourceToUpdate, setSourceToUpdate] = useState<PaymentSourceExtended | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const { apiClient, selectedPaymentSourceId, network, setSelectedPaymentSourceId } =
    useAppContext();
  const [filteredPaymentSources, setFilteredPaymentSources] = useState<PaymentSourceExtended[]>([]);

  const { paymentSources: ps, isLoading, refetch } = usePaymentSourceExtendedAll();

  const [paymentSources, setPaymentSources] = useState<PaymentSourceExtended[]>([]);
  useEffect(() => {
    setPaymentSources(ps.filter((ps) => ps.network === network));
  }, [ps, network]);

  const [sourceToSelect, setSourceToSelect] = useState<PaymentSourceExtended | undefined>(
    undefined,
  );
  const [selectedPaymentSourceForDetails, setSelectedPaymentSourceForDetails] =
    useState<PaymentSourceExtended | null>(null);

  const filterPaymentSources = useCallback(() => {
    let filtered = [...paymentSources];

    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter((source) => {
        const matchAddress = source.smartContractAddress?.toLowerCase().includes(query) || false;
        const matchNetwork = source.network?.toLowerCase().includes(query) || false;
        return matchAddress || matchNetwork;
      });
    }

    setFilteredPaymentSources(filtered);
  }, [paymentSources, searchQuery]);

  useEffect(() => {
    filterPaymentSources();
  }, [filterPaymentSources, searchQuery]);

  // Handle action query parameter from search
  useEffect(() => {
    if (router.query.action === 'add_payment_source') {
      setIsAddDialogOpen(true);
      // Clean up the query parameter
      router.replace('/payment-sources', undefined, { shallow: true });
    }
  }, [router.query.action, router]);

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
        onSuccess: async () => {
          toast.success('Payment source deleted successfully');
          refetch();
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
                href="https://docs.masumi.network/api-reference/payment-service/get-payment-source"
                target="_blank"
                className="text-primary hover:underline"
              >
                Learn more
              </Link>
            </p>
          </div>
          <div className="flex items-center gap-2">
            <RefreshButton
              onRefresh={() => {
                void refetch();
              }}
              isRefreshing={isLoading}
            />
            <Button
              className="flex items-center gap-2 bg-black text-white hover:bg-black/90"
              onClick={() => setIsAddDialogOpen(true)}
            >
              <Plus className="h-4 w-4" />
              Add payment source
            </Button>
          </div>
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
                  <th className="p-4 text-left text-sm font-medium truncate pl-6">
                    Contract address
                  </th>
                  <th className="p-4 text-left text-sm font-medium">ID</th>
                  <th className="p-4 text-left text-sm font-medium">Network</th>
                  <th className="p-4 text-left text-sm font-medium truncate">Fee rate</th>
                  <th className="p-4 text-left text-sm font-medium truncate">Created at</th>
                  <th className="p-4 text-left text-sm font-medium">Wallets</th>
                  <th className="w-20 p-4 pr-8"></th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <PaymentSourceTableSkeleton rows={5} />
                ) : filteredPaymentSources.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="text-center py-8">
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
                      <td className="p-4 pl-6">
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
                        <div className="text-sm">{(source.feeRatePermille / 10).toFixed(1)}%</div>
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
                      <td className="p-4 pr-8" onClick={(e) => e.stopPropagation()}>
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
        </div>

        <AddPaymentSourceDialog
          open={isAddDialogOpen}
          onClose={() => setIsAddDialogOpen(false)}
          onSuccess={() => {
            refetch();
          }}
        />

        <UpdatePaymentSourceDialog
          open={!!sourceToUpdate}
          onClose={() => setSourceToUpdate(null)}
          onSuccess={() => {
            refetch();
          }}
          paymentSourceId={sourceToUpdate?.id || ''}
          currentApiKey={sourceToUpdate?.PaymentSourceConfig?.rpcProviderApiKey || ''}
        />

        <ConfirmDialog
          open={!!sourceToDelete}
          onClose={() => setSourceToDelete(null)}
          title="Delete Payment Source"
          description={`Are you sure you want to delete this payment source? This will also delete all associated wallets and transactions. This action cannot be undone.`}
          onConfirm={handleDeleteSource}
          isLoading={isDeleting}
          requireConfirmation={true}
          confirmationText="DELETE"
          confirmationLabel="Type 'DELETE' to confirm deletion"
        />

        <ConfirmDialog
          open={sourceToSelect !== undefined}
          onClose={() => setSourceToSelect(undefined)}
          title="Switch Payment Source"
          description="Switching payment source will update the displayed agents, wallets, and related content. Continue?"
          onConfirm={() => {
            if (sourceToSelect?.id) {
              setSelectedPaymentSourceId(sourceToSelect.id);
            }
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
