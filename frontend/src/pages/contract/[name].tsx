import { useEffect, useState } from 'react';
import { useAppContext } from '@/lib/contexts/AppContext';
import { MainLayout } from "@/components/layout/MainLayout";
import { useRouter } from "next/router";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
// import { WalletSection } from '@/components/wallet/WalletSection';
import { AdminWalletSection } from '@/components/wallet/AdminWalletSection';
import { ContractTransactionList } from "@/components/dashboard/ContractTransactionList";
import { Button } from "@/components/ui/button";
import { WalletCard } from "@/components/wallet/WalletCard";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { CreateWalletModal } from "@/components/wallet/CreateWalletModal";
import { ImportWalletModal } from "@/components/wallet/ImportWalletModal";
import { Input } from "@/components/ui/input";

export default function ContractPage() {
  const router = useRouter();
  const { name } = router.query;
  const { state, dispatch } = useAppContext();
  
  const contract = state.paymentSources?.find((c: any) => c.name === name || c.id === name);

  if (!contract) return null;

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [selectedWalletType, setSelectedWalletType] = useState<string>('');
  const [showSetCollectionWalletModal, setShowSetCollectionWalletModal] = useState(false);
  const [collectionWalletAddress, setCollectionWalletAddress] = useState(contract.CollectionWallet?.walletAddress || '');
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const handleCreate = (type: string) => {
    setSelectedWalletType(type);
    setShowCreateModal(true);
  };

  const handleImport = (type: string) => {
    setSelectedWalletType(type);
    setShowImportModal(true);
  };

  const handleSaveCollectionWallet = async () => {
    try {
      const response = await fetch('/api/update-collection-wallet', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contractId: contract.id,
          walletAddress: collectionWalletAddress,
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to update collection wallet');
      }

      const updatedContract = await response.json();
      dispatch({
        type: 'SET_PAYMENT_SOURCES',
        payload: state.paymentSources.map((c: any) => 
          c.id === contract.id ? updatedContract : c
        ),
      });

      setShowSetCollectionWalletModal(false);
    } catch (error) {
      console.error('Failed to update collection wallet:', error);
    }
  };

  const handleDeleteContract = async () => {
    try {
      setIsDeleting(true);
      setDeleteError(null);
      console.log('delete-contract id', contract.id)
      const response = await fetch(`/api/delete-payment-source?id=${contract.id}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        throw new Error('Failed to delete contract');
      }

      dispatch({
        type: 'SET_PAYMENT_SOURCES',
        payload: state.paymentSources?.filter((c: any) => c.id !== contract.id) || []
      });

      setShowDeleteModal(false);
      router.push('/');
    } catch (error) {
      console.error('Failed to delete contract:', error);
      setDeleteError(error instanceof Error ? error.message : 'An unexpected error occurred');
    } finally {
      setIsDeleting(false);
    }
  };

  if (!contract) return null;
  console.log('contract', contract)

  return (
    <MainLayout>
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <div className="flex justify-between items-center">
              {contract.index && <CardTitle>
                Payment Source #{contract.index}
              </CardTitle>}
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
              <div>Address: {contract.addressToCheck || contract.address}</div>
              <div>Network: {contract.network}</div>
              {/* <div>Type: {name === 'default' ? 'Default Contract' : contract.type}</div> */}
              <div>Status: {contract.isSyncing ? 'Syncing' : 'Active'}</div>
              <div>Date Created: {new Date(contract.createdAt).toLocaleString()}</div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Smart Contract Wallets</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-3 gap-4">
            {contract.AdminWallets?.map((wallet: any, index: number) => (
              <WalletCard 
                key={wallet.walletAddress}
                type="admin"
                address={wallet.walletAddress}
                contractName={name as string}
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
                {contract.CollectionWallet ? 'Update' : 'Set'} Collection Wallet
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {contract.CollectionWallet ? (
              <WalletCard 
                type="collection"
                address={contract.CollectionWallet.walletAddress}
                contractName={name as string}
              />
            ) : (
              <div className="text-sm text-muted-foreground">No collection wallet configured</div>
            )}
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Purchasing Wallets</CardTitle>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => handleCreate('purchasing')}>
                Create Wallet
              </Button>
              <Button variant="secondary" onClick={() => handleImport('purchasing')}>
                Import Wallet
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-sm text-muted-foreground mb-4">
              <i className='text-muted-foreground'>Handles purchase transactions</i>
            </div>
            {contract.PurchasingWallets?.length > 0 ? (
              <div className="grid grid-cols-1 gap-4">
                {contract.PurchasingWallets.map((wallet: any) => (
                  <WalletCard 
                    key={wallet.id}
                    type="purchasing"
                    address={wallet.walletVkey}
                    contractName={name as string}
                  />
                ))}
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">No purchasing wallets added</div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Selling Wallets</CardTitle>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => handleCreate('selling')}>
                Create Wallet
              </Button>
              <Button variant="secondary" onClick={() => handleImport('selling')}>
                Import Wallet
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-sm text-muted-foreground mb-4">
              <i className='text-muted-foreground'>Handles selling transactions</i>
            </div>
            {contract.SellingWallets?.length > 0 ? (
              <div className="grid grid-cols-1 gap-4">
                {contract.SellingWallets.map((wallet: any) => (
                  <WalletCard 
                    key={wallet.id}
                    type="selling"
                    address={wallet.walletVkey}
                    contractName={name as string}
                  />
                ))}
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">No selling wallets added</div>
            )}
          </CardContent>
        </Card>
        
        <ContractTransactionList 
          contractAddress={contract.addressToCheck || contract.address}
          network={contract.network}
          contract={contract}
          paymentType={contract.paymentType || "WEB3_CARDANO_V1"}
        />
      </div>

      {showCreateModal && (
        <Dialog open={showCreateModal} onOpenChange={setShowCreateModal}>
          <CreateWalletModal type={selectedWalletType} onClose={() => setShowCreateModal(false)} />
        </Dialog>
      )}
      
      {showImportModal && (
        <Dialog open={showImportModal} onOpenChange={setShowImportModal}>
          <ImportWalletModal type={selectedWalletType} onClose={() => setShowImportModal(false)} />
        </Dialog>
      )}

      {showSetCollectionWalletModal && (
        <Dialog open={showSetCollectionWalletModal} onOpenChange={setShowSetCollectionWalletModal}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Set Collection Wallet Address</DialogTitle>
              <DialogDescription>
                Enter the wallet address that will receive the payments after they are processed by the Hot Wallet.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <Input
                placeholder="Enter wallet address"
                value={collectionWalletAddress}
                onChange={(e) => setCollectionWalletAddress(e.target.value)}
              />
              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={() => setShowSetCollectionWalletModal(false)}
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleSaveCollectionWallet}
                >
                  Save Address
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {showDeleteModal && (
        <Dialog open={showDeleteModal} onOpenChange={setShowDeleteModal}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete Contract</DialogTitle>
              <DialogDescription className="text-destructive">
                This action is irreversible. All associated wallets and configurations will be permanently deleted.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <p className="text-sm text-muted-foreground">
                Are you sure you want to delete this contract?
              </p>
              {deleteError && (
                <p className="text-sm text-destructive">
                  {deleteError}
                </p>
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