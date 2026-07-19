/* eslint-disable react-hooks/exhaustive-deps */
import { Button } from '@/components/ui/button';
import { RefreshCw, Share, ArrowLeftRight, PlusCircle } from 'lucide-react';
import { useState, useEffect, useRef, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAppContext } from '@/lib/contexts/AppContext';
import {
  getWallet,
  patchWallet,
  getSwapTransactions,
  postSwapCancel,
  postSwapAcknowledgeTimeout,
  getSwapConfirm,
} from '@/lib/api/generated';
import { toast } from 'react-toastify';
import { handleApiCall, validateCardanoAddress } from '@/lib/utils';
import { extractApiErrorMessage } from '@/lib/api-error';
import { isHotWalletType } from '@/lib/wallet-type';
import { WalletLink } from '@/components/ui/wallet-link';
import { SwapDialog } from '@/components/wallets/SwapDialog';
import { TransakWidget } from '@/components/wallets/TransakWidget';
import { CopyButton } from '@/components/ui/copy-button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { fetchAllUtxos } from '@/lib/wallet-balance';
import { appendInclusiveCursorPage } from '@/lib/pagination/cursor-pagination';
import {
  extractSwapAcknowledgePayload,
  extractSwapCancelPayload,
  extractSwapConfirmPayload,
  extractSwapTransactionsPayload,
} from './swap-api';
import { useSwapStatusPolling } from './useSwapStatusPolling';
import { useTokenBalances } from '@/lib/hooks/useTokenBalances';
import { useLowBalanceRules } from '@/lib/hooks/useLowBalanceRules';
import {
  EMPTY_LOW_BALANCE_SUMMARY,
  getAssetUnitBreakdown,
  getDeleteRuleDialogDescription,
  getRuleAssetLabel,
  getRuleAssetMetaFromPreset,
  parseThresholdInputToRaw,
  validateRuleTopupInput,
  type WalletWithBalance,
} from '@/components/wallets/wallet-details-utils';
import { TokenBalanceSection } from '@/components/wallets/sections/TokenBalanceSection';
import { LowBalanceRulesSection } from '@/components/wallets/sections/LowBalanceRulesSection';
import {
  SwapTransactionsSection,
  type SwapTx,
} from '@/components/wallets/sections/SwapTransactionsSection';
import { WalletExportSection } from '@/components/wallets/sections/WalletExportSection';
import { CollectionAddressSection } from '@/components/wallets/sections/CollectionAddressSection';
import { FundTransfersSection } from '@/components/wallets/sections/FundTransfersSection';

// Re-exported for the many call sites that import these types from this module.
export type { TokenBalance, WalletWithBalance } from '@/components/wallets/wallet-details-utils';

interface WalletDetailsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  wallet: WalletWithBalance | null;
  isChild?: boolean;
  /** When opened from AIAgentDetailsDialog with elevatedStack (over transaction modal). */
  elevatedChildStack?: boolean;
}

export function WalletDetailsDialog({
  isOpen,
  onClose,
  wallet,
  isChild,
  elevatedChildStack,
}: WalletDetailsDialogProps) {
  const queryClient = useQueryClient();
  const { apiClient, network } = useAppContext();
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
  // Local echo of a just-saved collection address for immediate UI feedback.
  // `undefined` means "no local save yet" — fall through to the wallet prop.
  const [savedCollectionAddress, setSavedCollectionAddress] = useState<string | null | undefined>(
    undefined,
  );

  const [swapTransactions, setSwapTransactions] = useState<SwapTx[]>([]);
  const [swapTxLoading, setSwapTxLoading] = useState(false);
  const [swapTxCursor, setSwapTxCursor] = useState<string | undefined>(undefined);
  const [hasMoreSwapTx, setHasMoreSwapTx] = useState(true);
  const SWAP_TX_LIMIT = 5;

  // Swap action state: which tx is being cancelled/acknowledged/polled
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);
  const [pollingTxId, setPollingTxId] = useState<string | null>(null);
  const pollingTxIdRef = useRef<string | null>(null);
  const fetchTokenBalancesRef = useRef<() => void>(() => {});
  const fetchWalletDetailsRef = useRef<() => void>(() => {});

  const invalidateWalletQueries = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['wallets'] }),
      queryClient.invalidateQueries({ queryKey: ['wallets-paginated'] }),
      queryClient.invalidateQueries({ queryKey: ['all-wallets'] }),
      queryClient.invalidateQueries({ queryKey: ['payment-source-wallets-all'] }),
      queryClient.invalidateQueries({ queryKey: ['payment-source-wallet-list'] }),
      queryClient.invalidateQueries({ queryKey: ['payment-sources-all'] }),
    ]);
  }, [queryClient]);

  const balances = useTokenBalances(wallet);
  const rules = useLowBalanceRules({ wallet, invalidateWalletQueries });

  const updateSwapTxStatus = useCallback((txId: string, updates: Partial<SwapTx>) => {
    setSwapTransactions((prev) => prev.map((tx) => (tx.id === txId ? { ...tx, ...updates } : tx)));
  }, []);

  const { startPolling: startSwapPolling, stopPolling: stopSwapPolling } = useSwapStatusPolling({
    apiClient,
    walletVkey: wallet?.walletVkey,
    onTimeout: () => {
      setPollingTxId(null);
      pollingTxIdRef.current = null;
      toast.warning('Polling timed out — use refresh to check again.', { theme: 'dark' });
    },
    onUpdate: (data) => {
      const currentTxId = pollingTxIdRef.current;
      const swapStatus = data.swapStatus;

      if (!currentTxId || !swapStatus) {
        return false;
      }

      if (
        swapStatus === 'OrderConfirmed' ||
        swapStatus === 'CancelConfirmed' ||
        swapStatus === 'Completed'
      ) {
        updateSwapTxStatus(currentTxId, { swapStatus });
        setPollingTxId(null);
        pollingTxIdRef.current = null;
        fetchTokenBalancesRef.current();
        fetchWalletDetailsRef.current();
        toast.success(
          swapStatus === 'CancelConfirmed'
            ? 'Cancel confirmed!'
            : swapStatus === 'OrderConfirmed'
              ? 'Order confirmed on-chain.'
              : 'Swap completed!',
          { theme: 'dark' },
        );
        return true;
      }

      if (swapStatus === 'OrderSubmitTimeout' || swapStatus === 'CancelSubmitTimeout') {
        updateSwapTxStatus(currentTxId, { swapStatus });
        setPollingTxId(null);
        pollingTxIdRef.current = null;
        toast.warning('Transaction timed out.', { theme: 'dark' });
        return true;
      }

      return false;
    },
  });

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
        onSuccess: (response) => {
          const cancelTxHash = extractSwapCancelPayload(response).cancelTxHash;
          updateSwapTxStatus(tx.id, {
            swapStatus: 'CancelPending',
            cancelTxHash: cancelTxHash || null,
          });
          toast.info('Cancel submitted — polling for confirmation…', { theme: 'dark' });
          if (cancelTxHash) {
            startPollingConfirm(tx.id, cancelTxHash);
          }
        },
        onError: (error: unknown) => {
          const msg = extractApiErrorMessage(error, 'Cancel failed.');
          if (msg.includes('already executed') || msg.includes('swap completed')) {
            updateSwapTxStatus(tx.id, { swapStatus: 'Completed' });
            toast.success('Order was already executed by the DEX — swap completed!', {
              theme: 'dark',
            });
            void balances.fetchTokenBalances();
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
        onSuccess: (response) => {
          const data = extractSwapAcknowledgePayload(response);
          const newStatus = data.swapStatus;
          const message = data.message;

          if (newStatus) {
            updateSwapTxStatus(tx.id, { swapStatus: newStatus });
          }
          void balances.fetchTokenBalances();
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

  const startPollingConfirm = useCallback(
    (txId: string, txHash: string) => {
      if (!wallet) return;
      setPollingTxId(txId);
      pollingTxIdRef.current = txId;
      startSwapPolling(txHash);
    },
    [startSwapPolling, wallet],
  );

  // Cleanup polling on unmount
  useEffect(() => {
    return stopSwapPolling;
  }, [stopSwapPolling]);

  fetchTokenBalancesRef.current = balances.fetchTokenBalances;
  fetchWalletDetailsRef.current = () => {
    void rules.refreshWalletDetails();
  };

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
          const data = extractSwapConfirmPayload(res);
          if (data.swapStatus && data.swapStatus !== tx.swapStatus) {
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
      const txs = extractSwapTransactionsPayload(result);
      let merged: typeof txs = [];
      if (cursor) {
        setSwapTransactions((prev) => {
          merged = appendInclusiveCursorPage(prev, txs, (tx) => tx.id);
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
      // Reset states when dialog is opened. Token + rule state reset inside
      // their hooks (fetchTokenBalances resets at call start; resetForNewWallet
      // clears rule drafts and the add-rule form).
      setExportedMnemonic(null);
      setSavedCollectionAddress(undefined);
      setSwapTransactions([]);
      setSwapTxCursor(undefined);
      setHasMoreSwapTx(true);
      rules.resetForNewWallet();
      fetchTokenBalancesRef.current?.();
      fetchWalletDetailsRef.current?.();
      if (network === 'Mainnet') {
        fetchSwapTransactions();
      }
    }
  }, [isOpen, wallet?.walletAddress]);

  const handleExport = async () => {
    if (!wallet || !isHotWalletType(wallet.type)) return;
    // Bind the narrowed type: TS drops narrowing on `wallet.type` inside the
    // callback below, and the previous `as 'Purchasing' | 'Selling'` cast is
    // what let Funding wallets reach an endpoint that rejected them.
    const walletType = wallet.type;
    setIsExporting(true);
    await handleApiCall(
      () =>
        getWallet({
          client: apiClient,
          query: {
            walletType,
            id: wallet.id,
            includeSecret: 'true',
          },
        }),
      {
        onSuccess: (response) => {
          setExportedMnemonic(response.data?.data?.Secret?.mnemonic || '');
        },
        onError: (error: unknown) => {
          toast.error(extractApiErrorMessage(error, 'Failed to export wallet'));
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

  const collectionAddress =
    savedCollectionAddress !== undefined
      ? savedCollectionAddress
      : (wallet?.collectionAddress ?? null);

  const handleEditCollectionAddress = () => {
    setIsEditingCollectionAddress(true);
    setNewCollectionAddress(collectionAddress || '');
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
      let isAddressUnused = false;
      try {
        const utxos = await fetchAllUtxos(apiClient, network, newCollectionAddress.trim());
        isAddressUnused = utxos.length === 0;
      } catch {
        isAddressUnused = true;
      }
      if (isAddressUnused) {
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
          setSavedCollectionAddress(newCollectionAddress.trim() || null);
          void invalidateWalletQueries();
        },
        onError: (error: unknown) => {
          toast.error(extractApiErrorMessage(error, 'Failed to update collection address'));
        },
        errorMessage: 'Failed to update collection address',
      },
    );
  };

  const handleCancelEdit = () => {
    setIsEditingCollectionAddress(false);
    setNewCollectionAddress('');
  };

  const handleDialogClose = useCallback(() => {
    // Drop the plaintext seed phrase immediately on close so it never
    // lingers in state or paints for the next wallet's dialog.
    setExportedMnemonic(null);
    setSelectedWalletForSwap(null);
    setSelectedWalletForTopup(null);
    rules.setPendingDeleteRule(null);
    onClose();
  }, [onClose, rules]);

  if (!wallet) return null;

  const monitoringSummary =
    rules.walletDetails?.LowBalanceSummary ?? wallet.LowBalanceSummary ?? EMPTY_LOW_BALANCE_SUMMARY;
  const configuredRules = rules.walletDetails?.LowBalanceRules ?? [];
  const lowRules = configuredRules.filter((rule) => rule.enabled && rule.status === 'Low');
  const enabledRuleCount = configuredRules.filter((rule) => rule.enabled).length;
  const addRuleAssetMeta = getRuleAssetMetaFromPreset(
    rules.newRuleAssetPreset,
    network,
    rules.newRuleCustomAssetUnit,
  );
  const newRuleAssetBreakdown = getAssetUnitBreakdown(rules.newRuleCustomAssetUnit);
  const newRuleRawThreshold = parseThresholdInputToRaw(
    rules.newRuleThresholdInput,
    addRuleAssetMeta.assetUnit,
    network,
  );
  const newRuleTopupValidation = validateRuleTopupInput({
    enabled: rules.newRuleTopupEnabled,
    topupAmountInput: rules.newRuleTopupAmountInput,
    assetUnit: addRuleAssetMeta.assetUnit,
    network,
  });
  const canCreateNewRule =
    addRuleAssetMeta.assetUnit.trim() !== '' &&
    newRuleRawThreshold != null &&
    newRuleTopupValidation.error == null;

  return (
    <>
      <Dialog
        open={isOpen}
        onOpenChange={(open) => {
          if (!open) {
            handleDialogClose();
          }
        }}
      >
        <DialogContent
          size="md"
          variant={isChild ? 'slide-from-right' : 'default'}
          isPushedBack={
            !!selectedWalletForTopup || !!selectedWalletForSwap || !!rules.pendingDeleteRule
          }
          hideOverlay={isChild}
          onBack={isChild ? handleDialogClose : undefined}
          elevatedChildStack={elevatedChildStack}
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
                aria-label="Refresh wallet"
                className="h-8 w-8"
                onClick={() => {
                  balances.fetchTokenBalances();
                  void rules.refreshWalletDetails();
                  if (network === 'Mainnet') {
                    setSwapTxCursor(undefined);
                    fetchSwapTransactions();
                  }
                }}
                disabled={balances.isLoading || rules.isWalletDetailsLoading}
              >
                <RefreshCw
                  className={`h-4 w-4 ${balances.isLoading || rules.isWalletDetailsLoading ? 'animate-spin' : ''}`}
                />
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

            {wallet.type !== 'Collection' && (
              <LowBalanceRulesSection
                monitoringSummary={monitoringSummary}
                configuredRules={configuredRules}
                lowRules={lowRules}
                enabledRuleCount={enabledRuleCount}
                network={network}
                supportsAutoTopup={wallet.type !== 'Funding'}
                isWalletDetailsLoading={rules.isWalletDetailsLoading}
                ruleDrafts={rules.ruleDrafts}
                mutatingRuleIds={rules.mutatingRuleIds}
                updateRuleDraft={rules.updateRuleDraft}
                onSaveRule={rules.handleSaveLowBalanceRule}
                onDeleteRule={rules.handleDeleteLowBalanceRule}
                newRuleAssetPreset={rules.newRuleAssetPreset}
                setNewRuleAssetPreset={rules.setNewRuleAssetPreset}
                newRuleThresholdInput={rules.newRuleThresholdInput}
                setNewRuleThresholdInput={rules.setNewRuleThresholdInput}
                newRuleCustomAssetUnit={rules.newRuleCustomAssetUnit}
                setNewRuleCustomAssetUnit={rules.setNewRuleCustomAssetUnit}
                newRuleEnabled={rules.newRuleEnabled}
                setNewRuleEnabled={rules.setNewRuleEnabled}
                newRuleTopupEnabled={rules.newRuleTopupEnabled}
                setNewRuleTopupEnabled={rules.setNewRuleTopupEnabled}
                newRuleTopupAmountInput={rules.newRuleTopupAmountInput}
                setNewRuleTopupAmountInput={rules.setNewRuleTopupAmountInput}
                addRuleAssetMeta={addRuleAssetMeta}
                newRuleAssetBreakdown={newRuleAssetBreakdown}
                newRuleRawThreshold={newRuleRawThreshold}
                newRuleRawTopup={newRuleTopupValidation.rawTopupAmount}
                newRuleTopupError={newRuleTopupValidation.error}
                canCreateNewRule={canCreateNewRule}
                onCreateRule={rules.handleCreateLowBalanceRule}
                isCreatingRule={rules.isCreatingRule}
              />
            )}

            <TokenBalanceSection
              isLoading={balances.isLoading}
              error={balances.error}
              tokenBalances={balances.tokenBalances}
              network={network}
              formatTokenBalance={balances.formatTokenBalance}
              isUSDCx={balances.isUSDCx}
              isUSDM={balances.isUSDM}
            />

            {network === 'Mainnet' && swapTransactions.length > 0 && (
              <SwapTransactionsSection
                swapTransactions={swapTransactions}
                swapTxLoading={swapTxLoading}
                hasMoreSwapTx={hasMoreSwapTx}
                swapTxCursor={swapTxCursor}
                pollingTxId={pollingTxId}
                actionLoadingId={actionLoadingId}
                network={network}
                onRefresh={() => {
                  setSwapTxCursor(undefined);
                  fetchSwapTransactions();
                }}
                onLoadMore={(cursor) => fetchSwapTransactions(cursor)}
                onCancelSwap={handleCancelSwap}
                onAcknowledgeTimeout={handleAcknowledgeTimeout}
                onStartPollingConfirm={startPollingConfirm}
              />
            )}

            <FundTransfersSection walletAddress={wallet.walletAddress} network={network} />

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
              <WalletExportSection
                exportedMnemonic={exportedMnemonic}
                onClose={() => setExportedMnemonic(null)}
                onCopyMnemonic={handleCopyMnemonic}
                onDownload={handleDownload}
              />
            )}

            {/* Linked Collection Wallet Section */}
            {(wallet.type === 'Selling' || wallet.type === 'Purchasing') && (
              <CollectionAddressSection
                walletType={wallet.type}
                network={network}
                collectionAddress={collectionAddress}
                isEditing={isEditingCollectionAddress}
                newCollectionAddress={newCollectionAddress}
                onNewCollectionAddressChange={setNewCollectionAddress}
                onSave={handleSaveCollection}
                onCancelEdit={handleCancelEdit}
                onStartEdit={handleEditCollectionAddress}
              />
            )}
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!rules.pendingDeleteRule}
        onClose={() => rules.setPendingDeleteRule(null)}
        elevatedGrandchildStack={elevatedChildStack}
        title={
          rules.pendingDeleteRule
            ? `Delete ${getRuleAssetLabel(rules.pendingDeleteRule.assetUnit, network)} rule?`
            : 'Delete low-balance rule?'
        }
        description={
          rules.pendingDeleteRule
            ? getDeleteRuleDialogDescription(rules.pendingDeleteRule, network)
            : 'Remove this low-balance rule?'
        }
        onConfirm={rules.handleConfirmDeleteLowBalanceRule}
        isLoading={
          rules.pendingDeleteRule != null && rules.mutatingRuleIds.has(rules.pendingDeleteRule.id)
        }
      />

      <SwapDialog
        isOpen={!!selectedWalletForSwap}
        onClose={() => setSelectedWalletForSwap(null)}
        walletAddress={selectedWalletForSwap?.walletAddress || ''}
        walletVkey={selectedWalletForSwap?.walletVkey || ''}
        network={network}
        elevatedGrandchildStack={elevatedChildStack}
        onSwapComplete={() => {
          balances.fetchTokenBalances();
          fetchSwapTransactions();
        }}
      />

      <TransakWidget
        isOpen={!!selectedWalletForTopup}
        onClose={() => setSelectedWalletForTopup(null)}
        walletAddress={selectedWalletForTopup?.walletAddress || ''}
        onSuccess={() => {
          toast.success('Top up successful');
          balances.fetchTokenBalances();
        }}
        isChild
        elevatedGrandchildStack={elevatedChildStack}
      />
    </>
  );
}
