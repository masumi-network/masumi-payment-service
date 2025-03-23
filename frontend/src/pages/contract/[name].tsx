/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState } from 'react';
import { useAppContext } from '@/lib/contexts/AppContext';
import { MainLayout } from '@/components/layout/MainLayout';
import { useRouter } from 'next/router';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { ContractTransactionList } from '@/components/dashboard/ContractTransactionList';
import { Button } from '@/components/ui/button';
import { WalletCard } from '@/components/wallet/WalletCard';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { AddWalletModal } from '@/components/wallet/AddWalletModal';
import { Input } from '@/components/ui/input';
import { toast } from 'react-toastify';
import BlinkingUnderscore from '@/components/BlinkingUnderscore';
import { GetStaticProps, GetStaticPaths } from 'next';
import {
  deletePaymentSourceExtended,
  getPaymentSource,
  patchPaymentSourceExtended,
} from '@/lib/api/generated';

interface ContractPageProps {
  initialContract: any | null;
}

export const getStaticPaths: GetStaticPaths = async () => {
  return {
    paths: [], // No pre-rendered paths
    fallback: false, // Generate pages on-demand
  };
};

export const getStaticProps: GetStaticProps<ContractPageProps> = async ({
  params,
}) => {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const name = params?.name as string;

  try {
    return {
      props: {
        initialContract: null, // Initial data will be loaded client-side
      },
    };
  } catch (error) {
    console.error('Error fetching contract:', error);
    return {
      props: {
        initialContract: null,
      },
    };
  }
};

export default function ContractPage({ initialContract }: ContractPageProps) {
  const router = useRouter();
  const { name } = router.query;
  const { state, dispatch } = useAppContext();

  const contract =
    state.paymentSources?.find((c: any) => c.name === name || c.id === name) ||
    initialContract;

  const [showAddWalletModal, setShowAddWalletModal] = useState(false);
  const [selectedWalletType, setSelectedWalletType] = useState<
    'purchasing' | 'selling'
  >('purchasing');
  const [showSetCollectionWalletModal, setShowSetCollectionWalletModal] =
    useState(false);
  const [collectionWalletAddress, setCollectionWalletAddress] = useState(
    contract?.CollectionWallet?.walletAddress || '',
  );
  const [collectionWalletNote, setCollectionWalletNote] = useState(
    contract?.CollectionWallet?.note || '',
  );
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);
  const { apiClient } = useAppContext();

  const handleAddWallet = (type: 'purchasing' | 'selling') => {
    setSelectedWalletType(type);
    setShowAddWalletModal(true);
  };

  const handleSaveCollectionWallet = async () => {
    try {
      setIsUpdating(true);
      //TODO: this is now per wallet
      alert('not implemented');
      return;
      await patchPaymentSourceExtended({
        client: apiClient,
        body: {
          id: contract.id,
        },
      });

      const sources = await getPaymentSource({
        client: apiClient,
      });

      const updatedContract = sources.data?.data?.PaymentSources.find(
        (c: any) => c.id === contract.id,
      );

      if (!updatedContract) {
        throw new Error('Updated contract not found in response');
      }

      dispatch({
        type: 'SET_PAYMENT_SOURCES',
        payload: state.paymentSources.map((c: any) =>
          c.id === contract.id ? updatedContract : c,
        ),
      });

      setShowSetCollectionWalletModal(false);
      toast.success('Collection wallet updated successfully', {
        position: 'top-right',
        autoClose: 5000,
        hideProgressBar: false,
        closeOnClick: true,
        pauseOnHover: true,
        draggable: true,
      });
    } catch (error) {
      console.error('Failed to update collection wallet:', error);
      toast.error('Failed to update collection wallet', {
        position: 'top-right',
        autoClose: 5000,
        hideProgressBar: false,
        closeOnClick: true,
        pauseOnHover: true,
        draggable: true,
      });
    } finally {
      setIsUpdating(false);
    }
  };

  const handleDeleteContract = async () => {
    try {
      setIsDeleting(true);
      setDeleteError(null);
      await deletePaymentSourceExtended({
        client: apiClient,
        query: { id: contract.id },
      });

      dispatch({
        type: 'SET_PAYMENT_SOURCES',
        payload:
          state.paymentSources?.filter((c: any) => c.id !== contract.id) || [],
      });

      setShowDeleteModal(false);
      router.push('/');
    } catch (error) {
      console.error('Failed to delete contract:', error);
      setDeleteError(
        error instanceof Error ? error.message : 'An unexpected error occurred',
      );
    } finally {
      setIsDeleting(false);
    }
  };

  const handleRemoveWallet = async (
    type: 'purchasing' | 'selling',
    walletId: string,
  ) => {
    try {
      await patchPaymentSourceExtended({
        client: apiClient,
        body: {
          id: contract.id,
          [`${type === 'purchasing' ? 'RemovePurchasingWallets' : 'RemoveSellingWallets'}`]:
            [{ id: walletId }],
        },
      });

      const sources = await getPaymentSource({
        client: apiClient,
      });
      const updatedContract = sources.data?.data?.PaymentSources.find(
        (c: any) => c.id === contract.id,
      );

      if (!updatedContract) {
        throw new Error('Updated contract not found in response');
      }

      dispatch({
        type: 'SET_PAYMENT_SOURCES',
        payload: state.paymentSources.map((c: any) =>
          c.id === contract.id ? updatedContract : c,
        ),
      });
    } catch (error: any) {
      toast.error('Failed to remove wallet ' + error.message);
    }
  };

  const getIndex = (contract: any) => {
    const sortedPaymentSources = state.paymentSources.sort(
      (a: any, b: any) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    return sortedPaymentSources.map((c: any) => c).indexOf(contract) + 1;
  };

  const contractIndex = contract?.index || getIndex(contract);

  return (
    <MainLayout>
      {contract ? (
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <div className="flex justify-between items-center">
                {contractIndex && (
                  <CardTitle>Payment Source #{contractIndex}</CardTitle>
                )}
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => setShowDeleteModal(true)}
                >
                  Delete Contract
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div>
                  Address:{' '}
                  {contract.addressToCheck || contract.paymentContractAddress}
                </div>
                <div>Network: {contract.network}</div>
                <div>Status: {contract.isSyncing ? 'Syncing' : 'Active'}</div>
                <div>
                  Date Created: {new Date(contract.createdAt).toLocaleString()}
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Smart Contract Wallets</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-3 gap-4">
              {contract.AdminWallets?.map((wallet: any) => (
                <WalletCard
                  key={wallet.walletAddress}
                  type="admin"
                  address={wallet.walletAddress}
                  contractName={name as string}
                  contract={contract}
                />
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex flex-row items-center justify-between">
                <CardTitle>Collection Wallet</CardTitle>
                <Button
                  variant="secondary"
                  onClick={() => setShowSetCollectionWalletModal(true)}
                >
                  {contract.CollectionWallet ? 'Update' : 'Set'} Collection
                  Wallet
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {contract.CollectionWallet ? (
                <WalletCard
                  type="collection"
                  address={contract.CollectionWallet.walletAddress}
                  contractName={name as string}
                  contract={contract}
                />
              ) : (
                <div className="text-sm text-muted-foreground">
                  No collection wallet configured
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>Purchasing Wallets</CardTitle>
              <Button
                variant="secondary"
                onClick={() => handleAddWallet('purchasing')}
              >
                Add Wallet
              </Button>
            </CardHeader>
            <CardContent>
              <div className="text-sm text-muted-foreground mb-4">
                <i className="text-muted-foreground">
                  Handles purchase transactions
                </i>
              </div>
              {contract.PurchasingWallets?.length > 0 ? (
                <div className="grid grid-cols-1 gap-4">
                  {contract.PurchasingWallets.map((wallet: any) => (
                    <WalletCard
                      key={wallet.id}
                      contract={contract}
                      type="purchasing"
                      address={wallet.walletAddress}
                      contractName={name as string}
                      walletId={wallet.id}
                      onRemove={() =>
                        handleRemoveWallet('purchasing', wallet.id)
                      }
                    />
                  ))}
                </div>
              ) : (
                <div className="text-sm text-muted-foreground">
                  No purchasing wallets added
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>Selling Wallets</CardTitle>
              <Button
                variant="secondary"
                onClick={() => handleAddWallet('selling')}
              >
                Add Wallet
              </Button>
            </CardHeader>
            <CardContent>
              <div className="text-sm text-muted-foreground mb-4">
                <i className="text-muted-foreground">
                  Handles selling transactions
                </i>
              </div>
              {contract.SellingWallets?.length > 0 ? (
                <div className="grid grid-cols-1 gap-4">
                  {contract.SellingWallets.map((wallet: any) => (
                    <WalletCard
                      key={wallet.id}
                      contract={contract}
                      type="selling"
                      address={wallet.walletAddress}
                      contractName={name as string}
                      walletId={wallet.id}
                      onRemove={() => handleRemoveWallet('selling', wallet.id)}
                    />
                  ))}
                </div>
              ) : (
                <div className="text-sm text-muted-foreground">
                  No selling wallets added
                </div>
              )}
            </CardContent>
          </Card>

          <ContractTransactionList
            contractAddress={
              contract.addressToCheck || contract.paymentContractAddress
            }
            network={contract.network}
            paymentType={contract.paymentType || 'WEB3_CARDANO_V1'}
          />
        </div>
      ) : (
        <BlinkingUnderscore />
      )}

      {showAddWalletModal && (
        <Dialog open={showAddWalletModal} onOpenChange={setShowAddWalletModal}>
          <AddWalletModal
            type={selectedWalletType}
            onClose={() => setShowAddWalletModal(false)}
            contractId={contract.id}
          />
        </Dialog>
      )}

      {showSetCollectionWalletModal && (
        <Dialog
          open={showSetCollectionWalletModal}
          onOpenChange={setShowSetCollectionWalletModal}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Set Collection Wallet Address</DialogTitle>
              <DialogDescription>
                Enter the wallet address that will receive the payments after
                they are processed by the Hot Wallet.
              </DialogDescription>
            </DialogHeader>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleSaveCollectionWallet();
              }}
              className="grid gap-4 py-4"
            >
              <div className="grid gap-2">
                <Input
                  placeholder="Enter wallet address"
                  value={collectionWalletAddress}
                  onChange={(e) => setCollectionWalletAddress(e.target.value)}
                  required
                  pattern="^addr(_test)?1[a-zA-Z0-9]+$"
                  title="Please enter a valid Cardano address starting with 'addr1' or 'addr_test1'"
                  disabled={isUpdating}
                />
                {!collectionWalletAddress && (
                  <p className="text-sm text-destructive">
                    Collection wallet address is required
                  </p>
                )}
              </div>
              <div className="grid gap-2">
                <Input
                  placeholder="Enter note (optional)"
                  value={collectionWalletNote}
                  onChange={(e) => setCollectionWalletNote(e.target.value)}
                  disabled={isUpdating}
                />
              </div>
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setShowSetCollectionWalletModal(false)}
                  disabled={isUpdating}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={!collectionWalletAddress || isUpdating}
                >
                  {isUpdating ? 'Updating...' : 'Save Address'}
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      )}

      {showDeleteModal && (
        <Dialog open={showDeleteModal} onOpenChange={setShowDeleteModal}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete Contract</DialogTitle>
              <DialogDescription className="text-destructive">
                This action is irreversible. All associated wallets and
                configurations will be permanently deleted.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <p className="text-sm text-muted-foreground">
                Are you sure you want to delete this contract?
              </p>
              {deleteError && (
                <p className="text-sm text-destructive">{deleteError}</p>
              )}
              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={() => setShowDeleteModal(false)}
                  disabled={isDeleting}
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  onClick={handleDeleteContract}
                  disabled={isDeleting}
                >
                  {isDeleting ? 'Deleting...' : 'Delete Contract'}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </MainLayout>
  );
}
