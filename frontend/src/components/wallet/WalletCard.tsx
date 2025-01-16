import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useRouter } from "next/router";
import { useEffect, useState } from "react";
import { useAppContext } from '@/lib/contexts/AppContext';
import { ChevronDown, ChevronUp } from "lucide-react";

export function WalletCard({ 
  type,
  address,
  contractName
}: {
  type: string;
  address: string;
  contractName: string;
}) {
  const [adaBalance, setAdaBalance] = useState<number>(0);
  const [usdmBalance, setUsdmBalance] = useState<number>(0);
  const [isRegistered, setIsRegistered] = useState<boolean>(false);
  const { state } = useAppContext();
  const router = useRouter();

  useEffect(() => {
    const fetchBalances = async () => {
      const defaultContract = state.paymentSources?.[0];
      const apiKey = defaultContract?.blockfrostKey;

      if (!apiKey) {
        console.error('No Blockfrost API key found');
        return;
      }

      try {
        const response = await fetch(`/api/wallet/balance?address=${address}&apiKey=${apiKey}`);
        if (!response.ok) throw new Error('Failed to fetch balance');
        
        const data = await response.json();
        setAdaBalance(data.ada);
        setUsdmBalance(data.usdm);
      } catch (error) {
        console.error('Error fetching wallet balances:', error);
      }
    };

    if (address) {
      fetchBalances();
    }
  }, [address, state.paymentSources]);

  const handleTopUp = (e:any) => {
    e.stopPropagation();
    window.open('https://transak.com', '_blank');
  };

  const handleExport = (e:any) => {
    e.stopPropagation();
  };

  const handleViewExplorer = (e:any) => {
    e.stopPropagation();
    window.open(`https://masumi.network/explorer/address/${address}`, '_blank');
  };

  const handleDeregister = (e:any) => {
    e.stopPropagation();
  };

  const shortenAddress = (addr: string) => {
    return `${addr.slice(0, 8)}...${addr.slice(-8)}`;
  };

  const getDisplayContent = () => {
    if (!address) {
      switch (type) {
        case 'receiver':
          return "No receiver address added";
        case 'payment':
          return "No payment address added";
        case 'collection':
          return "No collection address added";
        default:
          return "No address added";
      }
    }

    return (
      <>
        <div className="flex justify-between items-center">
          <div className="text-sm truncate flex-1">Address: {shortenAddress(address)}</div>
        </div>

        <div className="grid gap-2">
          <div className="text-sm">ADA Balance: {adaBalance.toLocaleString()} ₳</div>
          <div className="text-sm">USDM Balance: {usdmBalance.toLocaleString()} USDM</div>
          {type === 'hot' && (
            <div className="text-sm">Status: {isRegistered ? 'Registered' : 'Not registered'}</div>
          )}
        </div>

        <div className="flex gap-1 justify-start mt-1">
          {type === 'admin' && (
            <>
              <Button variant="secondary" size="sm" onClick={handleTopUp}>
                Top up
              </Button>
              <Button variant="secondary" size="sm" onClick={handleExport}>
                Export
              </Button>
            </>
          )}
          {type === 'hot' && isRegistered && (
            <>
              <Button variant="secondary" size="sm" onClick={handleViewExplorer}>
                View Explorer
              </Button>
              <Button variant="destructive" size="sm" onClick={handleDeregister}>
                De-register
              </Button>
            </>
          )}
        </div>
      </>
    );
  };

  return (
    <Card className="bg-[#ffffff03] hover:bg-[#ffffff06]">
      <CardContent className="space-y-1 py-4 px-3 flex flex-col gap-3">
        {getDisplayContent()}
      </CardContent>
    </Card>
  );
}