/* eslint-disable react-hooks/rules-of-hooks */
/* eslint-disable react-hooks/exhaustive-deps */
import { Button } from '@/components/ui/button';
import { RefreshCw, Share, X } from 'lucide-react';
import { useState, useEffect } from 'react';
import { useAppContext } from '@/lib/contexts/AppContext';
import { getUtxos, getWallet } from '@/lib/api/generated';
import { toast } from 'react-toastify';
import { shortenAddress } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';
import useFormatBalance from '@/lib/hooks/useFormatBalance';
import { useRate } from '@/lib/hooks/useRate';
import { SwapDialog } from '@/components/wallets/SwapDialog';
import { TransakWidget } from '@/components/wallets/TransakWidget';
import { CopyButton } from '@/components/ui/copy-button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';

interface TokenBalance {
  unit: string;
  policyId: string;
  assetName: string;
  quantity: number;
  displayName: string;
}

export interface WalletWithBalance {
  id: string;
  walletVkey: string;
  walletAddress: string;
  collectionAddress: string | null;
  note: string | null;
  type: 'Purchasing' | 'Selling' | 'Collection';
  balance: string;
  usdmBalance: string;
}

interface WalletDetailsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  wallet: WalletWithBalance | null;
}

export function WalletDetailsDialog({
  isOpen,
  onClose,
  wallet,
}: WalletDetailsDialogProps) {
  const { apiClient, state } = useAppContext();
  const [isLoading, setIsLoading] = useState(true);
  const [tokenBalances, setTokenBalances] = useState<TokenBalance[]>([]);
  const [error, setError] = useState<string | null>(null);
  const { rate } = useRate();
  const [selectedWalletForSwap, setSelectedWalletForSwap] =
    useState<WalletWithBalance | null>(null);
  const [selectedWalletForTopup, setSelectedWalletForTopup] =
    useState<WalletWithBalance | null>(null);
  const [exportedMnemonic, setExportedMnemonic] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);

  const fetchTokenBalances = async () => {
    if (!wallet) return;

    setIsLoading(true);
    setError(null);
    setTokenBalances([]); // Reset balances when refreshing
    try {
      const response = await getUtxos({
        client: apiClient,
        headers: {
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          Pragma: 'no-cache',
          Expires: '0',
        },
        query: {
          address: wallet.walletAddress,
          network: state.network,
        },
      });

      if (response.data?.data?.Utxos) {
        const balanceMap = new Map<string, number>();

        response.data.data.Utxos.forEach((utxo) => {
          utxo.Amounts.forEach((amount) => {
            const currentAmount = balanceMap.get(amount.unit) || 0;
            balanceMap.set(amount.unit, currentAmount + (amount.quantity || 0));
          });
        });

        const tokens: TokenBalance[] = [];
        balanceMap.forEach((quantity, unit) => {
          if (unit === 'lovelace' || unit === '') {
            tokens.push({
              unit: 'lovelace',
              policyId: '',
              assetName: 'ADA',
              quantity,
              displayName: 'ADA',
            });
          } else {
            // For other tokens, split into policy ID and asset name
            const policyId = unit.slice(0, 56);
            const assetNameHex = unit.slice(56);
            const assetName = hexToAscii(assetNameHex);

            tokens.push({
              unit,
              policyId,
              assetName,
              quantity,
              displayName: assetName || unit,
            });
          }
        });

        setTokenBalances(tokens);
      }
    } catch (error) {
      console.error('Failed to fetch token balances:', error);
      setError('Failed to fetch token balances');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen && wallet) {
      // Reset states when dialog is opened
      setTokenBalances([]);
      setError(null);
      setIsLoading(true);
      setExportedMnemonic(null);
      fetchTokenBalances();
    }
  }, [isOpen, wallet?.walletAddress]);

  const hexToAscii = (hex: string) => {
    try {
      const bytes =
        hex.match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) || [];
      return bytes.map((byte) => String.fromCharCode(byte)).join('');
    } catch {
      return hex;
    }
  };

  const formatTokenBalance = (token: TokenBalance) => {
    if (token.unit === 'lovelace') {
      const ada = token.quantity / 1000000;
      const formattedAmount =
        ada === 0 ? 'zero' : useFormatBalance(ada.toFixed(6));
      return {
        amount: formattedAmount,
        usdValue: rate ? `≈ $${(ada * rate).toFixed(2)}` : undefined,
      };
    }

    // For USDM, divide by 10^7
    if (token.displayName === 'USDM') {
      const usdm = token.quantity / 10000000;
      const formattedAmount =
        usdm === 0 ? 'zero' : useFormatBalance(usdm.toFixed(6));
      return {
        amount: formattedAmount,
        usdValue: `≈ $${usdm.toFixed(2)}`,
      };
    }

    // For other tokens, divide by 10^6 as a default
    const amount = token.quantity / 1000000;
    const formattedAmount =
      amount === 0 ? 'zero' : useFormatBalance(amount.toFixed(6));
    return {
      amount: formattedAmount,
      usdValue: undefined,
    };
  };

  const handleExport = async () => {
    if (!wallet || wallet.type === 'Collection') return;
    setIsExporting(true);
    try {
      const response = await getWallet({
        client: apiClient,
        query: {
          walletType: wallet.type as 'Purchasing' | 'Selling',
          id: wallet.id,
          includeSecret: 'true',
        },
      });
      setExportedMnemonic(response.data?.data?.Secret?.mnemonic || '');
    } catch {
      toast.error('Failed to export wallet');
    } finally {
      setIsExporting(false);
    }
  };

  const handleCopyMnemonic = async () => {
    if (exportedMnemonic) {
      await navigator.clipboard.writeText(exportedMnemonic);
      toast.success('Mnemonic copied to clipboard');
    }
  };

  const handleDownload = () => {
    if (!wallet || !exportedMnemonic) return;
    const data = {
      walletAddress: wallet.walletAddress,
      walletVkey: wallet.walletVkey,
      note: wallet.note,
      mnemonic: exportedMnemonic,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `wallet-export-${wallet.walletAddress}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!wallet) return null;

  return (
    <>
      <Dialog open={isOpen} onOpenChange={onClose}>
        <DialogContent className="sm:max-w-[600px]">
          <DialogHeader>
            <DialogTitle>Wallet Details</DialogTitle>
            <DialogDescription>
              {wallet.type} Wallet
              {wallet.note && ` - ${wallet.note}`}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 mt-4">
            <div className="bg-muted rounded-lg p-4">
              <div className="text-sm font-medium">Wallet Address</div>
              <div className="flex items-center gap-2 mt-1">
                <span className="font-mono text-sm">
                  {shortenAddress(wallet.walletAddress)}
                </span>
                <CopyButton value={wallet.walletAddress} />
              </div>
            </div>

            <div className="bg-muted rounded-lg p-4">
              <div className="text-sm font-medium">vKey</div>
              <div className="flex items-center gap-2 mt-1">
                <span className="font-mono text-sm break-all">
                  {shortenAddress(wallet.walletVkey)}
                </span>
                <CopyButton value={wallet.walletVkey} />
              </div>
            </div>

            {wallet.type !== 'Collection' && (
              <div className="flex items-center">
                <Button
                  variant="outline"
                  onClick={handleExport}
                  disabled={isExporting}
                  title="Export Wallet"
                >
                  <span className="">Export Wallet</span>
                  <Share className="h-4 w-4" />
                </Button>
              </div>
            )}
            {exportedMnemonic && (
              <div className="bg-muted rounded-lg p-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="text-sm font-medium ">Mnemonic</div>
                  <div>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => setExportedMnemonic(null)}
                      aria-label="Close"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                <textarea
                  className="w-full font-mono text-sm bg-background rounded p-2 mb-2"
                  value={exportedMnemonic}
                  readOnly
                  rows={3}
                  style={{ resize: 'none' }}
                />
                <div className="flex gap-2">
                  <Button onClick={handleCopyMnemonic} size="sm">
                    Copy Mnemonic
                  </Button>
                  <Button onClick={handleDownload} size="sm" variant="outline">
                    Download JSON
                  </Button>
                </div>
              </div>
            )}

            {/* Linked Collection Wallet Section */}
            {wallet.collectionAddress && wallet.type !== 'Collection' && (
              <div className="flex flex-col gap-1 mt-2 border-t pt-4">
                <div className="text-xs text-muted-foreground">
                  Linked Collection Wallet
                </div>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm">
                    {shortenAddress(wallet.collectionAddress)}
                  </span>
                  <CopyButton value={wallet.collectionAddress} />
                </div>
              </div>
            )}

            <div className="bg-muted rounded-lg p-4 space-y-2">
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium">Token Balances</div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={fetchTokenBalances}
                  disabled={isLoading}
                >
                  <RefreshCw className="h-4 w-4" />
                </Button>
              </div>
              {isLoading ? (
                <div className="flex justify-center py-4">
                  <Spinner size={20} />
                </div>
              ) : error ? (
                <div className="text-sm text-destructive">{error}</div>
              ) : (
                <div className="space-y-2">
                  {tokenBalances.length === 0 && (
                    <div className="text-xs text-muted-foreground">
                      No tokens found
                    </div>
                  )}
                  {tokenBalances.map((token) => {
                    const { amount, usdValue } = formatTokenBalance(token);
                    return (
                      <div
                        key={token.unit}
                        className="flex items-center justify-between rounded-md border p-3"
                      >
                        <div>
                          <div className="font-medium">{token.displayName}</div>
                          {token.policyId && (
                            <div className="text-xs text-muted-foreground">
                              Policy ID: {shortenAddress(token.policyId)}
                            </div>
                          )}
                        </div>
                        <div className="text-right">
                          <div>{amount}</div>
                          {usdValue && (
                            <div className="text-xs text-muted-foreground">
                              {usdValue}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <SwapDialog
        isOpen={!!selectedWalletForSwap}
        onClose={() => setSelectedWalletForSwap(null)}
        walletAddress={selectedWalletForSwap?.walletAddress || ''}
        network={state.network}
        blockfrostApiKey={process.env.NEXT_PUBLIC_BLOCKFROST_API_KEY || ''}
        walletType={selectedWalletForSwap?.type || ''}
        walletId={selectedWalletForSwap?.id || ''}
      />

      <TransakWidget
        isOpen={!!selectedWalletForTopup}
        onClose={() => setSelectedWalletForTopup(null)}
        walletAddress={selectedWalletForTopup?.walletAddress || ''}
        onSuccess={() => {
          toast.success('Top up successful');
          fetchTokenBalances();
        }}
      />
    </>
  );
}
