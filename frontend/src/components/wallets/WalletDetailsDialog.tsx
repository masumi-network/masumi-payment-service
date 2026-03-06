/* eslint-disable react-hooks/exhaustive-deps */
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  RefreshCw,
  Share,
  X,
  XCircle,
  AlertTriangle,
  ArrowLeftRight,
  PlusCircle,
} from 'lucide-react';
import { useState, useEffect, useRef, useCallback } from 'react';
import { useAppContext } from '@/lib/contexts/AppContext';
import {
  getUtxos,
  getWallet,
  patchWallet,
  getSwapTransactions,
  postSwapCancel,
  postSwapAcknowledgeTimeout,
  getSwapConfirm,
} from '@/lib/api/generated';
import { toast } from 'react-toastify';
import {
  handleApiCall,
  shortenAddress,
  getExplorerUrl,
  validateCardanoAddress,
  hexToAscii,
} from '@/lib/utils';
import { WalletLink } from '@/components/ui/wallet-link';
import { Spinner } from '@/components/ui/spinner';
import formatBalance from '@/lib/formatBalance';
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
import { getUsdmConfig } from '@/lib/constants/defaultWallets';

export interface TokenBalance {
  unit: string;
  policyId: string;
  assetName: string;
  quantity: number;
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
  isChild?: boolean;
}

export function WalletDetailsDialog({
  isOpen,
  onClose,
  wallet,
  isChild,
}: WalletDetailsDialogProps) {
  const { apiClient, network } = useAppContext();
  const [isLoading, setIsLoading] = useState(true);
  const [tokenBalances, setTokenBalances] = useState<TokenBalance[]>([]);
  const [error, setError] = useState<string | null>(null);
  const { rate } = useRate();
  const [selectedWalletForSwap, setSelectedWalletForSwap] = useState<WalletWithBalance | null>(
    null,
  );
  const [selectedWalletForTopup, setSelectedWalletForTopup] = useState<WalletWithBalance | null>(
    null,
  );
  const [exportedMnemonic, setExportedMnemonic] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [isEditingCollectionAddress, setIsEditingCollectionAddress] = useState(false);
  const [newCollectionAddress, setNewCollectionAddress] = useState('');

  interface SwapTx {
    id: string;
    createdAt: string;
    txHash: string | null;
    status: string;
    swapStatus?: string;
    confirmations?: number | null;
    fromPolicyId: string;
    fromAssetName: string;
    fromAmount: string;
    toPolicyId: string;
    toAssetName: string;
    poolId: string;
    slippage?: number | null;
    cancelTxHash?: string | null;
    orderOutputIndex?: number | null;
  }
  const [swapTransactions, setSwapTransactions] = useState<SwapTx[]>([]);
  const [swapTxLoading, setSwapTxLoading] = useState(false);
  const [swapTxCursor, setSwapTxCursor] = useState<string | undefined>(undefined);
  const [hasMoreSwapTx, setHasMoreSwapTx] = useState(true);
  const SWAP_TX_LIMIT = 5;

  // Swap action state: which tx is being cancelled/acknowledged/polled
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);
  const [pollingTxId, setPollingTxId] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fetchTokenBalancesRef = useRef<() => void>(() => {});

  const updateSwapTxStatus = useCallback((txId: string, updates: Partial<SwapTx>) => {
    setSwapTransactions((prev) => prev.map((tx) => (tx.id === txId ? { ...tx, ...updates } : tx)));
  }, []);

  const handleCancelSwap = async (tx: SwapTx) => {
    if (!wallet) return;
    setActionLoadingId(tx.id);

    await handleApiCall(
      () =>
        postSwapCancel({
          client: apiClient,
          body: { walletVkey: wallet.walletVkey, swapTransactionId: tx.id },
        }),
      {
        onSuccess: (response: any) => {
          const cancelTxHash = response?.data?.data?.cancelTxHash || response?.data?.cancelTxHash;
          updateSwapTxStatus(tx.id, {
            swapStatus: 'CancelPending',
            cancelTxHash: cancelTxHash || null,
          });
          toast.info('Cancel submitted — polling for confirmation…', { theme: 'dark' });
          if (cancelTxHash) {
            startPollingConfirm(tx.id, cancelTxHash);
          }
        },
        onError: (err: any) => {
          const msg = err?.message || err?.error?.message || '';
          if (msg.includes('already executed') || msg.includes('swap completed')) {
            updateSwapTxStatus(tx.id, { swapStatus: 'Completed' });
            toast.success('Order was already executed by the DEX — swap completed!', {
              theme: 'dark',
            });
            fetchTokenBalances();
          } else {
            toast.error(msg || 'Cancel failed.', { theme: 'dark' });
          }
        },
        errorMessage: 'Cancel swap failed',
      },
    );

    setActionLoadingId(null);
  };

  const handleAcknowledgeTimeout = async (tx: SwapTx) => {
    if (!wallet) return;
    setActionLoadingId(tx.id);

    await handleApiCall(
      () =>
        postSwapAcknowledgeTimeout({
          client: apiClient,
          body: { walletVkey: wallet.walletVkey, swapTransactionId: tx.id },
        }),
      {
        onSuccess: (response: any) => {
          const data = response?.data?.data ?? response?.data;
          const newStatus = data?.swapStatus;
          const message = data?.message;

          if (newStatus) {
            updateSwapTxStatus(tx.id, { swapStatus: newStatus });
          }
          fetchTokenBalances();
          toast.info(message || 'Timeout acknowledged.', { theme: 'dark' });
        },
        onError: () => {
          toast.error('Failed to acknowledge timeout.', { theme: 'dark' });
        },
        errorMessage: 'Acknowledge timeout failed',
      },
    );

    setActionLoadingId(null);
  };

  const MAX_POLL_MS = 5 * 60 * 1000; // 5 minutes

  const startPollingConfirm = useCallback(
    (txId: string, txHash: string) => {
      if (!wallet) return;
      if (pollRef.current) {
        clearTimeout(pollRef.current);
        pollRef.current = null;
      }
      setPollingTxId(txId);
      const startTime = Date.now();

      const poll = () => {
        if (Date.now() - startTime > MAX_POLL_MS) {
          setPollingTxId(null);
          toast.warning('Polling timed out — use refresh to check again.', { theme: 'dark' });
          return;
        }

        handleApiCall(
          () =>
            getSwapConfirm({
              client: apiClient,
              query: { txHash, walletVkey: wallet.walletVkey },
            }),
          {
            onSuccess: (response: any) => {
              const data = response?.data?.data ?? response?.data;
              const swapStatus = data?.swapStatus;

              if (
                swapStatus === 'OrderConfirmed' ||
                swapStatus === 'CancelConfirmed' ||
                swapStatus === 'Completed'
              ) {
                updateSwapTxStatus(txId, { swapStatus });
                setPollingTxId(null);
                fetchTokenBalancesRef.current();
                toast.success(
                  swapStatus === 'CancelConfirmed'
                    ? 'Cancel confirmed!'
                    : swapStatus === 'OrderConfirmed'
                      ? 'Order confirmed on-chain.'
                      : 'Swap completed!',
                  { theme: 'dark' },
                );
                return;
              }

              if (swapStatus === 'OrderSubmitTimeout' || swapStatus === 'CancelSubmitTimeout') {
                updateSwapTxStatus(txId, { swapStatus });
                setPollingTxId(null);
                toast.warning('Transaction timed out.', { theme: 'dark' });
                return;
              }

              pollRef.current = setTimeout(poll, 4000);
            },
            onError: () => {
              pollRef.current = setTimeout(poll, 4000);
            },
            errorMessage: '',
          },
        );
      };

      poll();
    },
    [wallet, apiClient, updateSwapTxStatus],
  );

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, []);

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
  fetchTokenBalancesRef.current = fetchTokenBalances;

  const checkPendingSwapStatuses = useCallback(
    async (txs: SwapTx[]) => {
      if (!wallet) return;
      const checkableTxs = txs.filter(
        (tx) =>
          (tx.swapStatus === 'OrderPending' ||
            tx.swapStatus === 'CancelPending' ||
            tx.swapStatus === 'OrderConfirmed') &&
          tx.txHash,
      );
      for (const tx of checkableTxs) {
        const hash = tx.swapStatus === 'CancelPending' ? tx.cancelTxHash : tx.txHash;
        if (!hash) continue;
        try {
          const res = await getSwapConfirm({
            client: apiClient,
            query: { txHash: hash, walletVkey: wallet.walletVkey },
          });
          const data = (res as any)?.data?.data ?? (res as any)?.data;
          if (data?.swapStatus && data.swapStatus !== tx.swapStatus) {
            updateSwapTxStatus(tx.id, { swapStatus: data.swapStatus });
          }
        } catch {
          // Ignore — best-effort status refresh
        }
      }
    },
    [wallet, apiClient, updateSwapTxStatus],
  );

  const fetchSwapTransactions = async (cursor?: string) => {
    if (!wallet) return;
    setSwapTxLoading(true);
    try {
      const result = await getSwapTransactions({
        client: apiClient,
        query: {
          walletVkey: wallet.walletVkey,
          limit: SWAP_TX_LIMIT,
          cursorId: cursor,
        },
      });
      const txs = (result as any)?.data?.data?.swapTransactions ?? [];
      let merged: typeof txs;
      if (cursor) {
        setSwapTransactions((prev) => {
          merged = [...prev, ...txs];
          return merged;
        });
      } else {
        merged = txs;
        setSwapTransactions(txs);
      }
      checkPendingSwapStatuses(merged);
      setHasMoreSwapTx(txs.length === SWAP_TX_LIMIT);
      if (txs.length > 0) {
        setSwapTxCursor(txs[txs.length - 1].id);
      }
    } catch {
      // Silently fail — swap transactions are supplementary info
    } finally {
      setSwapTxLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen && wallet) {
      // Reset states when dialog is opened
      setTokenBalances([]);
      setError(null);
      setIsLoading(true);
      setExportedMnemonic(null);
      setSwapTransactions([]);
      setSwapTxCursor(undefined);
      setHasMoreSwapTx(true);
      fetchTokenBalances();
      if (network === 'Mainnet') {
        fetchSwapTransactions();
      }
    }
  }, [isOpen, wallet?.walletAddress]);

  const usdmConfig = getUsdmConfig(network);

  const isUSDM = (token: TokenBalance) =>
    token.policyId === usdmConfig.policyId && token.assetName === hexToAscii(usdmConfig.assetName);

  const formatTokenBalance = (token: TokenBalance) => {
    if (token.unit === 'lovelace') {
      const ada = token.quantity / 1_000_000;
      return {
        amount: ada === 0 ? 'zero' : formatBalance(ada.toFixed(6)),
        usdValue: rate ? `≈ $${(ada * rate).toFixed(2)}` : undefined,
      };
    }

    if (isUSDM(token)) {
      const usdm = token.quantity / 1_000_000;
      return {
        amount: usdm === 0 ? 'zero' : formatBalance(usdm.toFixed(6)),
        usdValue: `≈ $${usdm.toFixed(2)}`,
      };
    }

    // Unknown tokens: display raw quantity (no decimal conversion)
    const qty = token.quantity;
    return {
      amount: qty === 0 ? 'zero' : formatBalance(qty.toString()),
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
      const validation = validateCardanoAddress(newCollectionAddress.trim(), network);
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
        open={isOpen}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedWalletForSwap(null);
            setSelectedWalletForTopup(null);
            onClose();
          }
        }}
      >
        <DialogContent
          className="sm:max-w-[600px]"
          variant={isChild ? 'slide-from-right' : 'default'}
          isPushedBack={!!selectedWalletForTopup || !!selectedWalletForSwap}
          hideOverlay={isChild}
          onBack={isChild ? onClose : undefined}
        >
          <DialogHeader>
            <div className="flex items-center justify-between">
              <div>
                <DialogTitle>Wallet Details</DialogTitle>
                <DialogDescription>{wallet.type} Wallet</DialogDescription>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => {
                  fetchTokenBalances();
                  if (network === 'Mainnet') {
                    setSwapTxCursor(undefined);
                    fetchSwapTransactions();
                  }
                }}
                disabled={isLoading}
              >
                <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
              </Button>
            </div>
          </DialogHeader>

          <div className="space-y-4 mt-4">
            {/* Wallet Address Section */}
            <div className="bg-muted rounded-lg p-4">
              <div className="text-sm font-medium">Wallet Address</div>
              <div className="mt-1">
                <WalletLink address={wallet.walletAddress} network={network} />
              </div>
            </div>

            {/* Wallet Note Section */}
            {wallet.note && (
              <div className="bg-muted rounded-lg p-4">
                <div className="text-sm font-medium">Note</div>
                <div className="text-sm mt-1 wrap-break-word">{wallet.note}</div>
              </div>
            )}

            {/* vKey Section */}
            <div className="bg-muted rounded-lg p-4">
              <div className="text-sm font-medium">vKey</div>
              <div className="flex items-center gap-2 mt-1">
                <span className="font-mono text-xs break-all">{wallet.walletVkey}</span>
                <CopyButton value={wallet.walletVkey} />
              </div>
            </div>

            <div className="bg-muted rounded-lg p-4 space-y-2">
              <div className="text-sm font-medium">Token Balances</div>
              {isLoading ? (
                <div className="flex justify-center py-4">
                  <Spinner size={20} />
                </div>
              ) : error ? (
                <div className="text-sm text-destructive">{error}</div>
              ) : (
                <div className="space-y-2">
                  {tokenBalances.length === 0 && (
                    <div className="text-xs text-muted-foreground">No tokens found</div>
                  )}
                  {/* Sort tokens: ADA first, then USDM, then others */}
                  {(() => {
                    const adaToken = tokenBalances.find((t) => t.unit === 'lovelace');
                    const usdmToken = tokenBalances.find((t) => isUSDM(t));
                    const otherTokens = tokenBalances.filter(
                      (t) => t.unit !== 'lovelace' && !isUSDM(t),
                    );
                    const sortedTokens = [adaToken, usdmToken, ...otherTokens].filter(
                      (t): t is TokenBalance => Boolean(t),
                    );

                    return sortedTokens.map((token) => {
                      const { amount, usdValue } = formatTokenBalance(token);
                      const isADA = token.unit === 'lovelace';
                      const isUsdm = isUSDM(token);
                      const assetHex = !isADA ? token.unit.slice(56) : '';

                      let displayName: string;
                      if (isADA) {
                        displayName = 'ADA';
                      } else if (isUsdm) {
                        displayName = `USDM (${shortenAddress(token.policyId)})`;
                      } else if (assetHex.length > 12) {
                        displayName = shortenAddress(assetHex);
                      } else if (assetHex) {
                        displayName = assetHex;
                      } else {
                        displayName = shortenAddress(token.policyId);
                      }

                      const tokenUrl =
                        !isADA && !isUsdm
                          ? getExplorerUrl(token.unit, network, 'token')
                          : undefined;

                      const inner = (
                        <>
                          <div>
                            <div className="font-medium font-mono">{displayName}</div>
                            {!isUsdm && token.policyId && (
                              <div className="text-xs text-muted-foreground">
                                Policy ID: {shortenAddress(token.policyId)}
                              </div>
                            )}
                          </div>
                          <div className="text-right">
                            <div>{amount}</div>
                            {usdValue && (
                              <div className="text-xs text-muted-foreground">{usdValue}</div>
                            )}
                          </div>
                        </>
                      );

                      if (tokenUrl) {
                        return (
                          <a
                            key={token.unit}
                            href={tokenUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="block rounded-md border dark:border-muted-foreground/20 hover:bg-accent transition-colors"
                          >
                            <div className="flex items-center justify-between p-3 cursor-pointer">
                              {inner}
                            </div>
                          </a>
                        );
                      }

                      return (
                        <div
                          key={token.unit}
                          className="flex items-center justify-between rounded-md border dark:border-muted-foreground/20 p-3"
                        >
                          {inner}
                        </div>
                      );
                    });
                  })()}
                </div>
              )}
            </div>

            {network === 'Mainnet' && swapTransactions.length > 0 && (
              <div className="bg-muted rounded-lg p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-medium">Swap Transactions</div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => {
                      setSwapTxCursor(undefined);
                      fetchSwapTransactions();
                    }}
                    disabled={swapTxLoading}
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${swapTxLoading ? 'animate-spin' : ''}`} />
                  </Button>
                </div>
                <div className="space-y-2">
                  {swapTransactions.map((tx) => {
                    const fromLabel = tx.fromPolicyId ? shortenAddress(tx.fromPolicyId) : 'ADA';
                    const toLabel = tx.toPolicyId ? shortenAddress(tx.toPolicyId) : 'ADA';
                    const displayStatus = tx.swapStatus || tx.status;

                    const statusDotMap: Record<string, string> = {
                      OrderPending: 'bg-yellow-500',
                      OrderConfirmed: 'bg-blue-500',
                      CancelPending: 'bg-orange-500',
                      CancelConfirmed: 'bg-purple-500',
                      Completed: 'bg-green-500',
                      Confirmed: 'bg-green-500',
                      Pending: 'bg-yellow-500',
                      OrderSubmitTimeout: 'bg-red-500',
                      CancelSubmitTimeout: 'bg-red-500',
                    };
                    const statusColorMap: Record<string, string> = {
                      OrderPending: 'text-yellow-500',
                      OrderConfirmed: 'text-blue-500',
                      CancelPending: 'text-orange-500',
                      CancelConfirmed: 'text-purple-500',
                      Completed: 'text-green-500',
                      Confirmed: 'text-green-500',
                      Pending: 'text-yellow-500',
                      OrderSubmitTimeout: 'text-red-500',
                      CancelSubmitTimeout: 'text-red-500',
                    };
                    const statusColor = statusColorMap[displayStatus] || 'text-red-500';
                    const dotColor = statusDotMap[displayStatus] || 'bg-red-500';
                    const statusLabelMap: Record<string, string> = {
                      OrderPending: 'Order Pending',
                      OrderConfirmed: 'Awaiting Execution',
                      CancelPending: 'Cancel Pending',
                      CancelConfirmed: 'Cancelled',
                      Completed: 'Completed',
                      OrderSubmitTimeout: 'Order Timeout',
                      CancelSubmitTimeout: 'Cancel Timeout',
                    };
                    const statusLabel = statusLabelMap[displayStatus] || displayStatus;

                    const isActionable =
                      displayStatus === 'OrderConfirmed' ||
                      displayStatus === 'OrderPending' ||
                      displayStatus === 'CancelPending' ||
                      displayStatus === 'OrderSubmitTimeout' ||
                      displayStatus === 'CancelSubmitTimeout';
                    const isPending =
                      displayStatus === 'OrderPending' || displayStatus === 'CancelPending';
                    const isTimeout =
                      displayStatus === 'OrderSubmitTimeout' ||
                      displayStatus === 'CancelSubmitTimeout';

                    return (
                      <div
                        key={tx.id}
                        className={`rounded-lg border p-3 space-y-2 transition-colors ${
                          isTimeout
                            ? 'border-red-500/30 bg-red-500/5'
                            : displayStatus === 'OrderConfirmed'
                              ? 'border-blue-500/20 bg-blue-500/5'
                              : 'dark:border-muted-foreground/20 border-border'
                        }`}
                      >
                        {/* Header row */}
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-medium">
                            {tx.fromAmount} {fromLabel} → {toLabel}
                          </span>
                          <div className="flex items-center gap-1.5">
                            {pollingTxId === tx.id && <Spinner size={12} />}
                            <span
                              className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${statusColor} bg-background/60`}
                            >
                              <span
                                className={`h-1.5 w-1.5 rounded-full ${dotColor} ${isPending ? 'animate-pulse' : ''}`}
                              />
                              {statusLabel}
                            </span>
                          </div>
                        </div>

                        {/* Tx links */}
                        <div className="flex items-center justify-between text-xs text-muted-foreground">
                          <span>{new Date(tx.createdAt).toLocaleString()}</span>
                          <div className="flex items-center gap-2">
                            {tx.cancelTxHash && (
                              <a
                                href={getExplorerUrl(tx.cancelTxHash, network, 'transaction')}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 hover:underline text-orange-500"
                                title="Cancel tx"
                              >
                                {shortenAddress(tx.cancelTxHash, 4)}
                              </a>
                            )}
                            {tx.txHash && (
                              <a
                                href={getExplorerUrl(tx.txHash, network, 'transaction')}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 hover:underline text-primary"
                              >
                                {shortenAddress(tx.txHash, 6)}
                              </a>
                            )}
                          </div>
                        </div>

                        {/* Actions */}
                        {isActionable && (
                          <div className="pt-1">
                            {displayStatus === 'OrderConfirmed' && (
                              <Button
                                variant="destructive"
                                size="sm"
                                className="w-full h-7 text-xs rounded-md"
                                onClick={() => handleCancelSwap(tx)}
                                disabled={actionLoadingId === tx.id || pollingTxId === tx.id}
                              >
                                {actionLoadingId === tx.id ? (
                                  <Spinner size={12} />
                                ) : (
                                  <>
                                    <XCircle className="h-3 w-3 mr-1" />
                                    Cancel Order
                                  </>
                                )}
                              </Button>
                            )}

                            {isPending && pollingTxId !== tx.id && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="w-full h-7 text-xs rounded-md text-muted-foreground hover:text-foreground"
                                onClick={() => {
                                  const hash =
                                    displayStatus === 'CancelPending' ? tx.cancelTxHash : tx.txHash;
                                  if (hash) startPollingConfirm(tx.id, hash);
                                }}
                                disabled={!tx.txHash && !tx.cancelTxHash}
                              >
                                <RefreshCw className="h-3 w-3 mr-1" />
                                Check Status
                              </Button>
                            )}

                            {isTimeout && (
                              <Button
                                variant="outline"
                                size="sm"
                                className="w-full h-7 text-xs rounded-md border-red-500/40 text-red-400 hover:bg-red-500/10"
                                onClick={() => handleAcknowledgeTimeout(tx)}
                                disabled={actionLoadingId === tx.id}
                              >
                                {actionLoadingId === tx.id ? (
                                  <Spinner size={12} />
                                ) : (
                                  <>
                                    <AlertTriangle className="h-3 w-3 mr-1" />
                                    Acknowledge &amp; Recover
                                  </>
                                )}
                              </Button>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                {hasMoreSwapTx && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full"
                    onClick={() => fetchSwapTransactions(swapTxCursor)}
                    disabled={swapTxLoading}
                  >
                    {swapTxLoading ? <Spinner size={16} /> : 'Load more'}
                  </Button>
                )}
              </div>
            )}

            {wallet.type !== 'Collection' && (
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  onClick={handleExport}
                  disabled={isExporting}
                  title="Export Wallet"
                >
                  <Share className="h-4 w-4" />
                  <span>Export Wallet</span>
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setSelectedWalletForTopup(wallet)}
                  title="Top Up"
                >
                  <PlusCircle className="h-4 w-4" />
                  <span>Top Up</span>
                </Button>
                {network === 'Mainnet' && (
                  <Button
                    variant="outline"
                    onClick={() => setSelectedWalletForSwap(wallet)}
                    title="Swap Assets"
                  >
                    <ArrowLeftRight className="h-4 w-4" />
                    <span>Swap Assets</span>
                  </Button>
                )}
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
                    <Button size="sm" onClick={handleSaveCollection} className="h-8">
                      Done
                    </Button>
                    <Button variant="outline" size="sm" onClick={handleCancelEdit} className="h-8">
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    {wallet.collectionAddress ? (
                      <>
                        <WalletLink
                          address={wallet.collectionAddress}
                          network={network}
                          shorten={15}
                        />
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
                        <span className="font-mono text-sm italic text-muted-foreground">none</span>
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
          </div>
        </DialogContent>
      </Dialog>

      <SwapDialog
        isOpen={!!selectedWalletForSwap}
        onClose={() => setSelectedWalletForSwap(null)}
        walletAddress={selectedWalletForSwap?.walletAddress || ''}
        walletVkey={selectedWalletForSwap?.walletVkey || ''}
        network={network}
        onSwapComplete={() => {
          fetchTokenBalances();
          fetchSwapTransactions();
        }}
      />

      <TransakWidget
        isOpen={!!selectedWalletForTopup}
        onClose={() => setSelectedWalletForTopup(null)}
        walletAddress={selectedWalletForTopup?.walletAddress || ''}
        onSuccess={() => {
          toast.success('Top up successful');
          fetchTokenBalances();
        }}
        isChild
      />
    </>
  );
}
