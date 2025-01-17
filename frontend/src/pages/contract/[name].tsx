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
import { Dialog } from "@/components/ui/dialog";
import { CreateWalletModal } from "@/components/wallet/CreateWalletModal";
import { ImportWalletModal } from "@/components/wallet/ImportWalletModal";

export default function ContractPage() {
  const router = useRouter();
  const { name } = router.query;
  const { state } = useAppContext();
  
  const contract = state.paymentSources?.find((c: any) => c.name === name || c.id === name);

  if (!contract) return null;

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [selectedWalletType, setSelectedWalletType] = useState<string>('');

  const handleCreate = (type: string) => {
    setSelectedWalletType(type);
    setShowCreateModal(true);
  };

  const handleImport = (type: string) => {
    setSelectedWalletType(type);
    setShowImportModal(true);
  };

  if (!contract) return null;
  console.log(contract);

  return (
    <MainLayout>
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>
              {name === 'default' ? 'Default Contract' : (contract.name)}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div>Address: {contract.addressToCheck || contract.address}</div>
              <div>Network: {contract.network}</div>
              <div>Type: {name === 'default' ? 'Default Contract' : contract.type}</div>
              <div>Status: {contract.isSyncing ? 'Syncing' : 'Active'}</div>
              <div>Last Updated: {new Date(contract.updatedAt || contract.lastUpdated).toLocaleString()}</div>
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

        {/* <Card>
          <CardHeader>
            <CardTitle>Collection Wallet</CardTitle>
          </CardHeader>
          <CardContent>
            {contract.CollectionWallet && (
              <WalletCard 
                type="collection"
                address={contract.CollectionWallet.walletAddress}
                contractName={name as string}
              />
            )}
          </CardContent>
        </Card> */}
        
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Payment Wallet</CardTitle>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => handleCreate('payment')}>
                Create Wallet
              </Button>
              <Button variant="secondary" onClick={() => handleImport('payment')}>
                Import Wallet
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-sm text-muted-foreground mb-4">
              <i className='text-muted-foreground'>Sends out payments to other Agents</i>
            </div>
            {contract.paymentWallet ? (
              <WalletCard 
                type="payment"
                address={contract.paymentWallet.walletAddress}
                contractName={name as string}
              />
            ) : (
              <div className="text-sm text-muted-foreground">No payment wallet added</div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Receiver Wallet</CardTitle>
            <Button variant="secondary" onClick={() => handleCreate('receiver')}>
              Set Address
            </Button>
          </CardHeader>
          <CardContent>
            <div className="text-sm text-muted-foreground mb-4">
              <i className='text-muted-foreground'>Receives payments from Hot Wallet (Hardware Wallet recommended)</i>
            </div>
            {contract.receiverWallet ? (
              <WalletCard 
                type="receiver"
                address={contract.receiverWallet.walletAddress}
                contractName={name as string}
              />
            ) : (
              <div className="text-sm text-muted-foreground">No receiver wallet added</div>
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
    </MainLayout>
  );
} 