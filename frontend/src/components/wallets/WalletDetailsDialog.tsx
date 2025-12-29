/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable react-hooks/exhaustive-deps */
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { RefreshCw, Share, X } from 'lucide-react';
import { useState, useEffect } from 'react';
import { useAppContext } from '@/lib/contexts/AppContext';
import { getUtxos, getWallet, patchWallet } from '@/lib/api/generated';
import { toast } from 'react-toastify';
import {
  handleApiCall,
  shortenAddress,
  getExplorerUrl,
  validateCardanoAddress,
  hexToAscii,
} from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';
import formatBalance from '@/lib/formatBalance';
import { useRate } from '@/lib/hooks/useRate';
//import { SwapDialog } from '@/components/wallets/SwapDialog';
import { TransakWidget } from '@/components/wallets/TransakWidget';
import { CopyButton } from '@/components/ui/copy-button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { getUsdmConfig } from '@/lib/constants/defaultWallets';

export interface TokenBalance {
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
  const { apiClient, network } = useAppContext();
  const [isLoading, setIsLoading] = useState(true);
  const [tokenBalances, setTokenBalances] = useState<TokenBalance[]>([]);
  const [error, setError] = useState<string | null>(null);
  const { rate } = useRate();
  //const [selectedWalletForSwap, setSelectedWalletForSwap] =
  //  useState<WalletWithBalance | null>(null);
  const [selectedWalletForTopup, setSelectedWalletForTopup] =
    useState<WalletWithBalance | null>(null);
  const [exportedMnemonic, setExportedMnemonic] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [isEditingCollectionAddress, setIsEditingCollectionAddress] =
    useState(false);
  const [newCollectionAddress, setNewCollectionAddress] = useState('');

  const fetchTokenBalances = async () => {
    if (!wallet) return;

    setIsLoading(true);
    setError(null);
    setTokenBalances([]); // Reset balances when refreshing

    await handleApiCall(
      () =>
        getUtxos({
          client: apiClient,
          headers: {
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            Pragma: 'no-cache',
            Expires: '0',
          },
          query: {
            address: wallet.walletAddress,
            network: network,
          },
        }),
      {
        onSuccess: (response: any) => {
          if (response.data?.data?.Utxos) {
            const balanceMap = new Map<string, number>();

            response.data.data.Utxos.forEach((utxo: any) => {
              utxo.Amounts.forEach((amount: any) => {
                const currentAmount = balanceMap.get(amount.unit) || 0;
                balanceMap.set(
                  amount.unit,
                  currentAmount + (amount.quantity || 0),
                );
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
        },
        onError: () => {
          // Don't set error for no token balances - treat as normal state
          setTokenBalances([]);
          setError(null);
        },
        onFinally: () => {
          setIsLoading(false);
        },
        errorMessage: 'Failed to fetch token balances',
      },
    );
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

  const formatTokenBalance = (token: TokenBalance) => {
    if (token.unit === 'lovelace') {
      const ada = token.quantity / 1000000;
      const formattedAmount =
        ada === 0 ? 'zero' : formatBalance(ada.toFixed(6));
      return {
        amount: formattedAmount,
        usdValue: rate ? `≈ $${(ada * rate).toFixed(2)}` : undefined,
      };
    }

    // For USDM, match by policyId and assetName (hex) - network aware
    const usdmConfig = getUsdmConfig(network);
    const isUSDM =
      token.policyId === usdmConfig.policyId &&
      token.assetName === hexToAscii(usdmConfig.assetName);
    if (isUSDM) {
      const usdm = token.quantity / 1000000;
      const formattedAmount =
        usdm === 0 ? 'zero' : formatBalance(usdm.toFixed(6));
      return {
        amount: formattedAmount,
        usdValue: `≈ $${usdm.toFixed(2)}`,
      };
    }

    // For other tokens, divide by 10^6 as a default
    const amount = token.quantity / 1000000;
    const formattedAmount =
      amount === 0 ? 'zero' : formatBalance(amount.toFixed(6));
    return {
      amount: formattedAmount,
      usdValue: undefined,
    };
  };

  const handleExport = async () => {
    if (!wallet || wallet.type === 'Collection') return;
    setIsExporting(true);
    await handleApiCall(
      () =>
        getWallet({
          client: apiClient,
          query: {
            walletType: wallet.type as 'Purchasing' | 'Selling',
            id: wallet.id,
            includeSecret: 'true',
          },
        }),
      {
        onSuccess: (response: any) => {
          setExportedMnemonic(response.data?.data?.Secret?.mnemonic || '');
        },
        onError: (error: any) => {
          toast.error(error.message || 'Failed to export wallet');
        },
        onFinally: () => {
          setIsExporting(false);
        },
        errorMessage: 'Failed to export wallet',
      },
    );
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

  const handleEditCollectionAddress = () => {
    setIsEditingCollectionAddress(true);
    setNewCollectionAddress(wallet?.collectionAddress || '');
  };

  const handleSaveCollection = async () => {
    if (!wallet) return;

    // Validate the address if provided
    if (newCollectionAddress.trim()) {
      const validation = validateCardanoAddress(
        newCollectionAddress.trim(),
        network,
      );
      if (!validation.isValid) {
        toast.error('Invalid collection address: ' + validation.error);
        return;
      }
      const balance = await getUtxos({
        client: apiClient,
        query: {
          address: newCollectionAddress.trim(),
          network: network,
        },
      });
      if (balance.error || balance.data?.data?.Utxos?.length === 0) {
        toast.warning(
          'Collection address has not been used yet, please check if this is the correct address',
        );
      }
    }
    await handleApiCall(
      () =>
        patchWallet({
          client: apiClient,
          body: {
            id: wallet.id,
            newCollectionAddress: newCollectionAddress.trim() || null,
          },
        }),
      {
        onSuccess: () => {
          toast.success('Collection address updated successfully');
          setIsEditingCollectionAddress(false);

          // Update the wallet object with the new collection address
          wallet.collectionAddress = newCollectionAddress.trim() || null;
        },
        onError: (error: any) => {
          toast.error(error.message || 'Failed to update collection address');
        },
        errorMessage: 'Failed to update collection address',
      },
    );
  };

  const handleCancelEdit = () => {
    setIsEditingCollectionAddress(false);
    setNewCollectionAddress('');
  };

  if (!wallet) return null;

  return (
    <>
      <Dialog
        open={isOpen && !selectedWalletForTopup}
        onOpenChange={(open) => {
          if (!open) {
            //setSelectedWalletForSwap(null);
            setSelectedWalletForTopup(null);
            onClose();
          }
        }}
      >
        <DialogContent className="sm:max-w-[600px]">
          <DialogHeader>
            <DialogTitle>Wallet Details</DialogTitle>
            <DialogDescription>{wallet.type} Wallet</DialogDescription>
          </DialogHeader>

          <div className="space-y-4 mt-4">
            {/* Wallet Address Section */}
            <div className="bg-muted rounded-lg p-4">
              <div className="text-sm font-medium">Wallet Address</div>
              <div className="flex items-center gap-2 mt-1">
                <a
                  href={getExplorerUrl(wallet.walletAddress, network)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-sm break-all hover:underline text-primary"
                >
                  {wallet.walletAddress}
                </a>
                <CopyButton value={wallet.walletAddress} />
              </div>
            </div>

            {/* Wallet Note Section */}
            {wallet.note && (
              <div className="bg-muted rounded-lg p-4">
                <div className="text-sm font-medium">Note</div>
                <div className="text-sm mt-1 break-words">{wallet.note}</div>
              </div>
            )}

            {/* vKey Section */}
            <div className="bg-muted rounded-lg p-4">
              <div className="text-sm font-medium">vKey</div>
              <div className="flex items-center gap-2 mt-1">
                <span className="font-mono text-xs break-all">
                  {wallet.walletVkey}
                </span>
                <CopyButton value={wallet.walletVkey} />
              </div>
            </div>

            {wallet.type !== 'Collection' && (
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  onClick={handleExport}
                  disabled={isExporting}
                  title="Export Wallet"
                >
                  <span>Export Wallet</span>
                  <Share className="h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setSelectedWalletForTopup(wallet)}
                  title="Top Up"
                >
                  <span>Top Up</span>
                </Button>
                {/*<Button
                  variant="outline"
                  onClick={() => setSelectedWalletForSwap(wallet)}
                  title="Swap Assets"
                >
                  <span>Swap Assets</span>
                </Button>*/}
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
            {(wallet.type === 'Selling' || wallet.type === 'Purchasing') && (
              <div className="flex flex-col gap-1 mt-2 border-t pt-4">
                <div className="text-xs text-muted-foreground">
                  {wallet.type === 'Selling'
                    ? 'Linked Revenue Collection Address'
                    : 'Linked Refund Collection Address'}
                </div>
                {isEditingCollectionAddress ? (
                  <div className="flex items-center gap-2">
                    <Input
                      value={newCollectionAddress}
                      onChange={(e) => setNewCollectionAddress(e.target.value)}
                      placeholder="Enter collection wallet address"
                      className="flex-1"
                    />
                    <Button
                      size="sm"
                      onClick={handleSaveCollection}
                      className="h-8"
                    >
                      Done
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleCancelEdit}
                      className="h-8"
                    >
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    {wallet.collectionAddress ? (
                      <>
                        <a
                          href={getExplorerUrl(
                            wallet.collectionAddress,
                            network,
                          )}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-mono text-sm hover:underline text-primary"
                        >
                          {shortenAddress(wallet.collectionAddress, 15)}
                        </a>
                        <CopyButton value={wallet.collectionAddress} />
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={handleEditCollectionAddress}
                          className="h-8"
                        >
                          Update
                        </Button>
                      </>
                    ) : (
                      <>
                        <span className="font-mono text-sm italic text-muted-foreground">
                          none
                        </span>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={handleEditCollectionAddress}
                          className="h-8"
                        >
                          Add
                        </Button>
                      </>
                    )}
                  </div>
                )}
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
                  {/* Sort tokens: ADA first, then USDM, then others */}
                  {(() => {
                    const adaToken = tokenBalances.find(
                      (t) => t.unit === 'lovelace',
                    );
                    const usdmConfig = getUsdmConfig(network);
                    const usdmToken = tokenBalances.find(
                      (t) =>
                        t.policyId === usdmConfig.policyId &&
                        t.assetName === hexToAscii(usdmConfig.assetName),
                    );
                    const otherTokens = tokenBalances.filter(
                      (t) =>
                        t.unit !== 'lovelace' &&
                        !(
                          t.policyId === usdmConfig.policyId &&
                          t.assetName === hexToAscii(usdmConfig.assetName)
                        ),
                    );
                    // Filter out undefined tokens before mapping
                    const sortedTokens = [
                      adaToken,
                      usdmToken,
                      ...otherTokens,
                    ].filter((t): t is TokenBalance => Boolean(t));
                    return sortedTokens.map((token) => {
                      const { amount, usdValue } = formatTokenBalance(token);
                      const isUSDM =
                        token.policyId === usdmConfig.policyId &&
                        token.assetName === hexToAscii(usdmConfig.assetName);
                      const displayName =
                        isUSDM && token.policyId
                          ? `USDM (${shortenAddress(token.policyId)})`
                          : token.displayName;
                      return (
                        <div
                          key={token.unit}
                          className="flex items-center justify-between rounded-md border dark:border-muted-foreground/20 p-3"
                        >
                          <div>
                            <div className="font-medium">{displayName}</div>
                            {!isUSDM && token.policyId && (
                              <div className="text-xs text-muted-foreground">
                                Policy ID: {shortenAddress(token.policyId)}
                              </div>
                            )}
                          </div>
                          <div className="text-right">
                            <div>{amount}</div>
                            {/* Only show USD value for non-USDM tokens */}
                            {usdValue && !isUSDM && (
                              <div className="text-xs text-muted-foreground">
                                {usdValue}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    });
                  })()}
                </div>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/*<SwapDialog
        isOpen={!!selectedWalletForSwap}
        onClose={() => setSelectedWalletForSwap(null)}
        walletAddress={selectedWalletForSwap?.walletAddress || ''}
        network={state.network}
        blockfrostApiKey={process.env.NEXT_PUBLIC_BLOCKFROST_API_KEY || ''}
        walletType={selectedWalletForSwap?.type || ''}
        walletId={selectedWalletForSwap?.id || ''}
      />*/}

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
