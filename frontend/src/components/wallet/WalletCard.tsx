import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useRouter } from "next/router";
import { useEffect, useState } from "react";
import { useAppContext } from '@/lib/contexts/AppContext';
import { ChevronDown, ChevronUp, Copy } from "lucide-react";
import Transak from '@transak/transak-sdk';
import { toast } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";

export function WalletCard({ 
  type,
  address,
  contractName,
  walletId,
  onRemove
}: {
  type: string;
  address: string;
  contractName: string;
  walletId?: string;
  onRemove?: () => void;
}) {
  const [adaBalance, setAdaBalance] = useState<number | null>(null);
  const [usdmBalance, setUsdmBalance] = useState<number | null>(null);
  const [fetchingBalance, setFetchingBalance] = useState<boolean>(true)
  const [isRegistered, setIsRegistered] = useState<boolean>(false);
  const [balanceError, setBalanceError] = useState<any>(null)
  const [isUpdating, setIsUpdating] = useState(false);
  const { state } = useAppContext();
  const router = useRouter();
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [walletSecret, setWalletSecret] = useState<string | null>(null);

  const fetchBalancePreprod = async (address: string) => {
    const API_KEY = state.paymentSources?.[0]?.blockfrostApiKey;
    const BASE_URL = `https://cardano-${type === 'mainnet' ? 'mainnet' : 'preprod'}.blockfrost.io/api/v0`;
  
    try {
      setFetchingBalance(true)
      const response = await fetch(`${BASE_URL}/addresses/${address}/utxos`, {
        headers: {
          project_id: API_KEY,
        },
      });
      
      if (!response.ok) {
        throw new Error(`Error: ${response.statusText}`);
      }
      
      const utxos = await response.json();
      const usdmPolicyId = "c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad";
      const usdmHex = "0014df105553444d"
      
      const balanceAda = utxos.reduce((total: any, utxo: any) => {
        const value = utxo.amount.find((amt: any) => amt.unit === "lovelace");
        return total + (value ? parseInt(value.quantity) : 0);
      }, 0);

      const balanceUsdm = utxos.reduce((total: any, utxo: any) => {
        const value = utxo.amount.find((amt: any) => amt.unit?.startsWith(usdmPolicyId));
        return total + (value ? parseInt(value.quantity) : 0);
      }, 0);

      console.log(utxos);
  
      return {
        ada: balanceAda / 1000000,
        usdm: balanceUsdm || 0
      };
    } catch (error: any) {
      console.error("Error fetching balance:", error.message);
      return null;
    }
  };

  useEffect(() => {
    const fetchBalances = async () => {
      const defaultContract = state.paymentSources?.[0];
      const apiKey = defaultContract?.blockfrostApiKey;

      if (!apiKey) {
        console.error('No Blockfrost API key found');
        return;
      }

      try {
        setFetchingBalance(true)
        setBalanceError(null)
        const data: any = await fetchBalancePreprod(address);
        setAdaBalance(data?.ada || "0");
        setUsdmBalance(data?.usdm || "0");
        setFetchingBalance(false)
      } catch (error) {
        console.error('Error fetching wallet balances:', error);
        setFetchingBalance(false)
        setBalanceError(error)
      }
    };
    
    if (address) {
      fetchBalances();
    }
  }, [address, state.paymentSources]);
  
  const refreshBalance = async()=>{
    try{
      setBalanceError(null)
      setFetchingBalance(true)
      const data:any = await fetchBalancePreprod(address)
      setAdaBalance(data?.ada || "0")
      setUsdmBalance(data?.usdm || "0")
      setFetchingBalance(false)
    } catch(error){
      console.error('Error fetching wallet balances:', error);
      setFetchingBalance(false)
      setBalanceError(error)
    }
  }

  const handleTopUp = (e: any) => {
    e.stopPropagation();
    
    const transak = new (Transak as any)({
      apiKey: process.env.NEXT_PUBLIC_TRANSAK_API_KEY,
      environment: process.env.NODE_ENV === 'production' ? 'PRODUCTION' : 'STAGING',
      defaultCryptoCurrency: 'ADA',
      walletAddress: address,
      defaultNetwork: type === 'mainnet' ? 'cardano' : 'cardano_preprod',
      cryptoCurrencyList: 'ADA',
      defaultPaymentMethod: 'credit_debit_card',
      exchangeScreenTitle: 'Top up your wallet',
      hideMenu: true,
      themeColor: '#000000',
      hostURL: window.location.origin,
      widgetHeight: '650px',
      widgetWidth: '450px'
    });

    transak.init();

    transak.on(transak.EVENTS.TRANSAK_WIDGET_CLOSE, () => {
      transak.close();
    });

    transak.on(transak.EVENTS.TRANSAK_ORDER_SUCCESSFUL, (orderData: any) => {
      console.log('Order successful:', orderData);
      transak.close();
    });
  };

  const walletType = type === 'selling' ? 'Selling' : 'Purchasing';

  const handleExport = async (e: any) => {
    e.stopPropagation();
    setIsExporting(true);

    try {
      const response = await fetch(`/api/wallet?walletType=${walletType}&id=${walletId}&includeSecret=true`, {
        headers: {
          'accept': 'application/json',
          'token': process.env.NEXT_PUBLIC_API_KEY as string
        }
      });

      if (!response.ok) {
        throw new Error('Failed to export wallet');
      }

      const data = await response.json();
      setWalletSecret(data.data.walletSecret.secret);
      setShowExportDialog(true);
    } catch (error) {
      console.error('Error exporting wallet:', error);
      toast.error('Failed to export wallet');
    } finally {
      setIsExporting(false);
    }
  };

  const handleViewExplorer = (e:any) => {
    e.stopPropagation();
    window.open(`https://masumi.network/explorer/?address=${address}`, '_blank');
  };

  const handleDeregister = (e:any) => {
    e.stopPropagation();
  };

  const shortenAddress = (addr: string) => {
    return `${addr.slice(0, 8)}...${addr.slice(-8)}`;
  };

  const handleCopyAddress = (e: React.MouseEvent, address: string) => {
    e.stopPropagation();
    navigator.clipboard.writeText(address);
    toast.success('Address copied to clipboard!');
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
          <div className="text-sm truncate flex-1">
            Address: {shortenAddress(address)}
            <Button
              variant="ghost"
              size="icon"
              className="h-4 w-4 ml-2"
              onClick={(e) => handleCopyAddress(e, address)}
            >
              <Copy className="h-3 w-3" />
            </Button>
          </div>
        </div>

        <div className="grid gap-2">
          {!fetchingBalance ? <>
            <div className="text-sm">ADA Balance: {adaBalance?.toLocaleString() || "..."} ₳</div>
            <div className="text-sm">USDM Balance: {usdmBalance?.toLocaleString() || "..."} USDM</div>
          </> : <div className="text-sm">
            fetching balance...
          </div>}
        </div>

        <div className="flex gap-1 justify-start mt-1">
          {(type === 'purchasing' || type === 'selling') && (
            <>
              <Button variant="secondary" size="sm" onClick={handleTopUp} disabled={isExporting}>
                Top up
              </Button>
              <Button variant="secondary" size="sm" onClick={handleExport} disabled={isExporting}>
                {isExporting ? 'Exporting...' : 'Export'}
              </Button>
            </>
          )}
        </div>
      </>
    );
  };

  return (
    <>
      <Card className="bg-[#ffffff03] hover:bg-[#ffffff06]">
        <CardContent className="space-y-1 py-4 px-3 flex flex-col gap-3">
          {getDisplayContent()}
          {(type === 'purchasing' || type === 'selling') && walletId && (
            <Button
              variant="destructive"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                setShowDeleteDialog(true);
              }}
              disabled={isUpdating}
              style={{ maxWidth: '100px' }}
            >
              Remove Wallet
            </Button>
          )}
        </CardContent>
      </Card>

      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove Wallet</DialogTitle>
            <DialogDescription>
              Are you sure you want to remove this wallet? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end space-x-2">
            <Button
              variant="outline"
              onClick={() => setShowDeleteDialog(false)}
              disabled={isUpdating}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={(e) => {
                e.stopPropagation();
                onRemove?.();
                setShowDeleteDialog(false);
              }}
              disabled={isUpdating}
            >
              Remove Wallet
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={showExportDialog} onOpenChange={setShowExportDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Wallet Secret</DialogTitle>
            <DialogDescription>
              Please store this secret phrase securely. Anyone with access to this phrase can control the wallet.
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4">
            <div className="p-4 bg-muted rounded-md">
              <p className="text-sm break-all font-mono">{walletSecret}</p>
            </div>
            
            <Button 
              className="w-full"
              onClick={() => {
                navigator.clipboard.writeText(walletSecret || '');
                toast.success('Secret copied to clipboard!');
              }}
            >
              Copy to Clipboard
            </Button>
          </div>

          <div className="flex justify-end">
            <Button
              variant="outline"
              onClick={() => {
                setShowExportDialog(false);
                setWalletSecret(null);
              }}
            >
              Close
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}