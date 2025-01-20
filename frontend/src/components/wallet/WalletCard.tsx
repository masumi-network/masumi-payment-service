/* eslint-disable @typescript-eslint/no-explicit-any */
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useEffect, useState, useCallback } from "react";
import { useAppContext } from '@/lib/contexts/AppContext';
import { Copy } from "lucide-react";
import { Transak } from '@transak/transak-sdk';
import { toast } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import BlinkingUnderscore from "../BlinkingUnderscore";

export function WalletCard({
  type,
  address,
  walletId,
  onRemove,
  contract,
  network
}: {
  type: string;
  address: string;
  contractName: string;
  walletId?: string;
  onRemove?: () => void;
  contract: any;
  network: string;
}) {
  const [adaBalance, setAdaBalance] = useState<number | null>(null);
  const [usdmBalance, setUsdmBalance] = useState<number | null>(null);
  const [fetchingBalance, setFetchingBalance] = useState<boolean>(true);
  const [, setBalanceError] = useState<any>(null);
  const [isUpdating,] = useState(false);
  const [localAddress, setLocalAddress] = useState<string | null>(address || null);
  const [, setIsFetchingAddress] = useState(false);
  const { state } = useAppContext();
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [walletSecret, setWalletSecret] = useState<string | null>(null);

  const walletType = type === 'selling' ? 'Selling' : 'Purchasing';

  const fetchWalletAddress = useCallback(async () => {
    try {
      setIsFetchingAddress(true);
      const response = await fetch(`${process.env.NEXT_PUBLIC_PAYMENT_API_BASE_URL}/api/v1/wallet?walletType=${walletType}&id=${walletId}`, {
        headers: {
          'accept': 'application/json',
          'token': state.apiKey!
        }
      });

      if (!response.ok) {
        throw new Error('Failed to fetch wallet address');
      }

      const data = await response.json();
      return data.data.address;
    } catch (error) {
      console.error('Error fetching wallet address:', error);
      return null;
    } finally {
      setIsFetchingAddress(false);
    }
  }, [state.apiKey, walletType, walletId]);

  useEffect(() => {
    if (!localAddress && walletId) {
      fetchWalletAddress().then(fetchedAddress => {
        if (fetchedAddress) {
          setLocalAddress(fetchedAddress);
        }
      });
    }
  }, [localAddress, walletId, fetchWalletAddress]);

  const fetchBalancePreprod = useCallback(async (address: string) => {

    try {
      setFetchingBalance(true)
      const response = await fetch(`${process.env.NEXT_PUBLIC_PAYMENT_API_BASE_URL}/api/v1/utxos?address=${address}&count=100&order=asc&page=1&network=${network.toLowerCase() === 'mainnet' ? 'MAINNET' : network.toLowerCase() === 'preprod' ? 'PREPROD' : 'PREVIEW'}`, {
        headers: {
          'accept': 'application/json',
          'token': state.apiKey!
        }
      });

      if (!response.ok) {
        throw new Error(`Error: ${response.statusText}`);
      }

      const utxos = await response.json();
      console.log("u", utxos)
      const usdmPolicyId = "c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad";
      //const usdmHex = "0014df105553444d"

      const balanceAda = utxos.data.utxos.reduce((total: any, utxo: any) => {
        const value = utxo.amount.find((amt: any) => amt.unit === "lovelace");
        return total + (value ? value.quantity : 0);
      }, 0);

      const balanceUsdm = utxos.data.utxos.reduce((total: any, utxo: any) => {
        const value = utxo.amount.find((amt: any) => amt.unit?.startsWith(usdmPolicyId));
        return total + (value ? value.quantity : 0);
      }, 0);

      return {
        ada: (balanceAda / 1000000).toFixed(1),
        usdm: (balanceUsdm).toFixed(1)
      };
    } catch (error: any) {
      console.error("Error fetching balance:", error.message);
      return null;
    }
  }, [state.apiKey, network,]);

  useEffect(() => {
    const fetchBalances = async () => {
      const defaultContract = state.paymentSources?.[0];
      const apiKey = defaultContract?.rpcProviderApiKey;

      if (!apiKey) {
        console.error('No Blockfrost API key found');
        return;
      }

      try {
        setFetchingBalance(true);
        setBalanceError(null);
        const data: any = await fetchBalancePreprod(localAddress || '');
        setAdaBalance(data?.ada || "0");
        setUsdmBalance(data?.usdm || "0");
        setFetchingBalance(false);
      } catch (error) {
        console.error('Error fetching wallet balances:', error);
        setFetchingBalance(false);
        setBalanceError(error);
      }
    };

    if (localAddress) {
      fetchBalances();
    }
  }, [localAddress, state.paymentSources, state.apiKey, fetchBalancePreprod]);

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const refreshBalance = async () => {
    try {
      setBalanceError(null)
      setFetchingBalance(true)
      const data: any = await fetchBalancePreprod(localAddress || '')
      setAdaBalance(data?.ada || "0")
      setUsdmBalance(data?.usdm || "0")
      setFetchingBalance(false)
    } catch (error) {
      console.error('Error fetching wallet balances:', error);
      setFetchingBalance(false)
      setBalanceError(error)
    }
  }

  const handleTopUp = (e: any) => {
    e.stopPropagation();
    const network = contract.network?.toLowerCase();

    if (network === 'preprod') {
      window.open('https://docs.cardano.org/cardano-testnets/tools/faucet', '_blank');
      return;
    }

    const transak = new (Transak as any)({
      apiKey: process.env.NEXT_PUBLIC_TRANSAK_API_KEY,
      environment: process.env.NODE_ENV === 'production' ? 'PRODUCTION' : 'STAGING',
      defaultCryptoCurrency: 'ADA',
      walletAddress: localAddress || '',
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

  const handleExport = async (e: any) => {
    e.stopPropagation();
    setIsExporting(true);

    try {
      const response = await fetch(`${process.env.NEXT_PUBLIC_PAYMENT_API_BASE_URL}/api/v1/wallet?walletType=${walletType}&id=${walletId}&includeSecret=true`, {
        headers: {
          'accept': 'application/json',
          'token': state.apiKey!
        }
      });

      if (!response.ok) {
        throw new Error('Failed to export wallet');
      }

      const data = await response.json();
      setWalletSecret(data.data.WalletSecret.secret);
      setShowExportDialog(true);
    } catch (error) {
      console.error('Error exporting wallet:', error);
      toast.error('Failed to export wallet');
    } finally {
      setIsExporting(false);
    }
  };

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const handleViewExplorer = (e: any) => {
    e.stopPropagation();
    window.open(`https://masumi.network/explorer/?address=${localAddress}`, '_blank');
  };

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const handleDeregister = (e: any) => {
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
    // if (isFetchingAddress) {
    //   return <div className="text-sm">Fetching wallet address...</div>;
    // }

    // if (!localAddress) {
    //   switch (type) {
    //     case 'receiver':
    //       return "No receiver address added";
    //     case 'payment':
    //       return "No payment address added";
    //     case 'collection':
    //       return "No collection address added";
    //     default:
    //       return "No address added";
    //   }
    // }

    return (
      <>
        <div className="flex justify-between items-center">
          <div className="text-sm truncate flex-1">
            Address: {localAddress ? shortenAddress(localAddress) : <BlinkingUnderscore />}
            {localAddress && <Button
              variant="ghost"
              size="icon"
              className="h-4 w-4 ml-2"
              onClick={(e) => handleCopyAddress(e, localAddress || '')}
            >
              <Copy className="h-3 w-3" />
            </Button>}
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

          </div>

          <div className="flex justify-end space-x-2">
            <Button
              onClick={() => {
                navigator.clipboard.writeText(walletSecret || '');
                toast.success('Secret copied to clipboard!');
              }}
            >
              Copy to Clipboard
            </Button>
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