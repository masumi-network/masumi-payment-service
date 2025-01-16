import { MainLayout } from "@/components/layout/MainLayout";
import { useRouter } from "next/router";
import { useEffect, useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { WalletTransactionList } from "@/components/dashboard/WalletTransactionList";
import { BlockfrostProvider } from "@meshsdk/core";
import { useAppContext } from "@/lib/contexts/AppContext";

export default function WalletDetails() {
  const router = useRouter();
  const { name, address } = router.query;
  const { state } = useAppContext();
  const [balance, setBalance] = useState<{ lovelace: string; assets: any[] }>({ lovelace: "0", assets: [] });
  const [isLoading, setIsLoading] = useState(true);

  const contract = state.paymentSources?.find(
    (c: any) => c.name === name || c.id === name
  );

  useEffect(() => {
    const fetchBalance = async () => {
      if (!address || !contract?.blockfrostApiKey) return;
      
      try {
        const blockfrost: any = new BlockfrostProvider(contract.blockfrostApiKey);
        const balanceData = await blockfrost.getBalance(address as string);
        setBalance(balanceData);
      } catch (error) {
        console.error('Error fetching balance:', error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchBalance();
  }, [address, contract]);

  const handleTopUp = () => {
    window.open('https://transak.com', '_blank');
  };

  if (!contract) return null;

  return (
    <MainLayout>
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Wallet Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="text-sm">Address: {address}</div>
            <div className="text-sm">
              Balance: {isLoading ? "Loading..." : `${parseInt(balance.lovelace) / 1000000} ₳`}
            </div>
            <Button onClick={handleTopUp}>Top up wallet</Button>
          </CardContent>
        </Card>

        <WalletTransactionList walletAddress={address as string} />
      </div>
    </MainLayout>
  );
} 