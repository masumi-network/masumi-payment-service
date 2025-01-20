/* eslint-disable @typescript-eslint/no-explicit-any */
import { useAppContext } from '@/lib/contexts/AppContext';
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { useRouter } from 'next/router';

export function AdminWalletSection({ contractId }: { contractId: string }) {
  const { state } = useAppContext();
  const router = useRouter();
  const contract = state.paymentSources?.find(c => c.id === contractId || c.name === contractId);

  if (!contract) return null;

  const handleWalletClick = (address: string) => {
    router.push(`/contract/${contractId}/wallet/${address}`);
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Admin Wallets</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          {contract.AdminWallets.map((wallet: any, index: any) => (
            <Card
              key={wallet.walletAddress}
              className="bg-[#fff1] hover:bg-[#fff2] cursor-pointer transition-colors"
              onClick={() => handleWalletClick(wallet.walletAddress)}
            >
              <CardContent className="pt-6">
                <div className="text-sm">Address: {wallet.walletAddress}</div>
                <div className="text-sm text-muted-foreground">Admin Wallet {index + 1}</div>
              </CardContent>
            </Card>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Collection Wallet</CardTitle>
        </CardHeader>
        <CardContent>
          <Card
            className="bg-[#fff1] hover:bg-[#fff2] cursor-pointer transition-colors"
            onClick={() => handleWalletClick(contract.CollectionWallet.walletAddress)}
          >
            <CardContent className="pt-6">
              <div className="text-sm">Address: {contract.CollectionWallet.walletAddress}</div>
              {contract.CollectionWallet.note && (
                <div className="text-sm text-muted-foreground">{contract.CollectionWallet.note}</div>
              )}
            </CardContent>
          </Card>
        </CardContent>
      </Card>
    </div>
  );
} 