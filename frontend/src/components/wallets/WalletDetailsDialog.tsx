/* eslint-disable react-hooks/exhaustive-deps */
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
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
import { useQueryClient } from '@tanstack/react-query';
import { useAppContext } from '@/lib/contexts/AppContext';
import {
  deleteWalletLowBalance,
  getUtxos,
  getWallet,
  patchWallet,
  patchWalletLowBalance,
  postWalletLowBalance,
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
import { extractApiErrorMessage } from '@/lib/api-error';
import { WalletLink } from '@/components/ui/wallet-link';
import { Spinner } from '@/components/ui/spinner';
import formatBalance from '@/lib/formatBalance';
import { useRate } from '@/lib/hooks/useRate';
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
import { getUsdmConfig, USDCX_CONFIG } from '@/lib/constants/defaultWallets';
import { appendInclusiveCursorPage } from '@/lib/pagination/cursor-pagination';
import {
  extractSwapAcknowledgePayload,
  extractSwapCancelPayload,
  extractSwapConfirmPayload,
  extractSwapTransactionsPayload,
} from './swap-api';
import { useSwapStatusPolling } from './useSwapStatusPolling';

export interface TokenBalance {
  unit: string;
  policyId: string;
  assetName: string;
  quantity: number;
}

type LowBalanceSummary = {
  isLow: boolean;
  lowRuleCount: number;
  lastCheckedAt: Date | null;
};

type LowBalanceRule = {
  id: string;
  assetUnit: string;
  thresholdAmount: string;
  enabled: boolean;
  status: 'Unknown' | 'Healthy' | 'Low';
  lastKnownAmount: string | null;
  lastCheckedAt: Date | null;
  lastAlertedAt: Date | null;
};

type WalletDetailsState = {
  LowBalanceSummary: LowBalanceSummary;
  LowBalanceRules: LowBalanceRule[];
};

type RuleDraft = {
  thresholdInput: string;
  enabled: boolean;
};

type RuleAssetPreset = 'lovelace' | 'stablecoin' | 'custom';

type RuleAssetMeta = {
  assetUnit: string;
  label: string;
  decimals: number | null;
  inputLabel: string;
  helperText: string;
};

const EMPTY_LOW_BALANCE_SUMMARY: LowBalanceSummary = {
  isLow: false,
  lowRuleCount: 0,
  lastCheckedAt: null,
};

const SUPPORTED_RULE_DECIMALS = 6;
const CARDANO_POLICY_ID_HEX_LENGTH = 56;

function getAssetUnitBreakdown(assetUnit: string) {
  const normalized = assetUnit.trim();
  const policyId = normalized.slice(0, CARDANO_POLICY_ID_HEX_LENGTH);
  const assetNameHex = normalized.slice(CARDANO_POLICY_ID_HEX_LENGTH);
  const decodedAssetName = assetNameHex ? hexToAscii(assetNameHex) : '';

  return {
    policyId,
    assetNameHex,
    decodedAssetName,
  };
}

function getStablecoinRuleMeta(network: 'Preprod' | 'Mainnet'): RuleAssetMeta {
  const stablecoin = network === 'Mainnet' ? USDCX_CONFIG : getUsdmConfig(network);

  return {
    assetUnit: stablecoin.fullAssetId,
    label: network === 'Mainnet' ? 'USDCx' : 'tUSDM',
    decimals: SUPPORTED_RULE_DECIMALS,
    inputLabel: `Threshold (${network === 'Mainnet' ? 'USDCx' : 'tUSDM'})`,
    helperText: 'Stored on-chain with 6 decimals.',
  };
}

function getRuleAssetMeta(assetUnit: string, network: 'Preprod' | 'Mainnet'): RuleAssetMeta {
  if (assetUnit === 'lovelace') {
    return {
      assetUnit: 'lovelace',
      label: 'ADA',
      decimals: SUPPORTED_RULE_DECIMALS,
      inputLabel: 'Threshold (ADA)',
      helperText: 'Stored on-chain as lovelace with 6 decimals.',
    };
  }

  const stablecoin = getStablecoinRuleMeta(network);
  if (assetUnit === stablecoin.assetUnit) {
    return stablecoin;
  }

  const assetName = hexToAscii(assetUnit.slice(CARDANO_POLICY_ID_HEX_LENGTH));

  return {
    assetUnit,
    label: assetName || shortenAddress(assetUnit, 8),
    decimals: null,
    inputLabel: 'Threshold (raw units)',
    helperText: 'Custom assets are configured in raw on-chain quantity.',
  };
}

function getRuleAssetMetaFromPreset(
  preset: RuleAssetPreset,
  network: 'Preprod' | 'Mainnet',
  customAssetUnit: string,
): RuleAssetMeta {
  if (preset === 'lovelace') {
    return getRuleAssetMeta('lovelace', network);
  }

  if (preset === 'stablecoin') {
    return getStablecoinRuleMeta(network);
  }

  return getRuleAssetMeta(customAssetUnit.trim(), network);
}

function formatDecimalString(rawAmount: string, decimals: number) {
  const normalized = rawAmount.replace(/^0+(?=\d)/, '') || '0';
  const padded = normalized.padStart(decimals + 1, '0');
  const whole = padded.slice(0, -decimals).replace(/^0+(?=\d)/, '') || '0';
  const fraction = padded.slice(-decimals).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

function parseDecimalToRawAmount(displayAmount: string, decimals: number) {
  const normalized = displayAmount.trim();

  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    return null;
  }

  const [wholePart, fractionalPart = ''] = normalized.split('.');
  if (fractionalPart.length > decimals) {
    return null;
  }

  const combined = `${wholePart}${fractionalPart.padEnd(decimals, '0')}`;
  return combined.replace(/^0+(?=\d)/, '') || '0';
}

function getThresholdInputFromRaw(
  rawAmount: string,
  assetUnit: string,
  network: 'Preprod' | 'Mainnet',
) {
  const assetMeta = getRuleAssetMeta(assetUnit, network);

  if (assetMeta.decimals == null) {
    return rawAmount;
  }

  return formatDecimalString(rawAmount, assetMeta.decimals);
}

function parseThresholdInputToRaw(
  thresholdInput: string,
  assetUnit: string,
  network: 'Preprod' | 'Mainnet',
) {
  const assetMeta = getRuleAssetMeta(assetUnit, network);

  if (assetMeta.decimals == null) {
    const normalized = thresholdInput.trim();
    return /^\d+$/.test(normalized) ? normalized : null;
  }

  return parseDecimalToRawAmount(thresholdInput, assetMeta.decimals);
}

function formatRuleAmount(
  amount: string | null,
  assetUnit: string,
  network: 'Preprod' | 'Mainnet',
) {
  if (amount == null) {
    return 'Unknown';
  }

  const assetMeta = getRuleAssetMeta(assetUnit, network);

  if (assetMeta.decimals != null) {
    return `${formatBalance(formatDecimalString(amount, assetMeta.decimals))} ${assetMeta.label}`;
  }

  return `${formatBalance(amount)} raw`;
}

function getRuleAssetLabel(assetUnit: string, network: 'Preprod' | 'Mainnet') {
  return getRuleAssetMeta(assetUnit, network).label;
}

function getDeleteRuleDialogDescription(rule: LowBalanceRule, network: 'Preprod' | 'Mainnet') {
  const assetMeta = getRuleAssetMeta(rule.assetUnit, network);
  const lines = [
    `Remove the low-balance rule for ${assetMeta.label}?`,
    'This stops interval checks and submission-time warnings for this asset until you add the rule again.',
  ];

  if (assetMeta.decimals == null) {
    lines.push(`Asset unit: ${rule.assetUnit}`);
  }

  return lines.join('\n\n');
}

export interface WalletWithBalance {
  id: string;
  walletVkey: string;
  walletAddress: string;
  collectionAddress: string | null;
  note: string | null;
  type: 'Purchasing' | 'Selling' | 'Collection';
  balance: string;
  usdcxBalance: string;
  LowBalanceSummary?: LowBalanceSummary;
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
  const queryClient = useQueryClient();
  const { apiClient, network } = useAppContext();
  const [isLoading, setIsLoading] = useState(true);
  const [isWalletDetailsLoading, setIsWalletDetailsLoading] = useState(false);
  const [tokenBalances, setTokenBalances] = useState<TokenBalance[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [walletDetails, setWalletDetails] = useState<WalletDetailsState | null>(null);
  const [ruleDrafts, setRuleDrafts] = useState<Record<string, RuleDraft>>({});
  const [newRuleAssetPreset, setNewRuleAssetPreset] = useState<RuleAssetPreset>('lovelace');
  const [newRuleCustomAssetUnit, setNewRuleCustomAssetUnit] = useState('');
  const [newRuleThresholdInput, setNewRuleThresholdInput] = useState('');
  const [newRuleEnabled, setNewRuleEnabled] = useState(true);
  const [mutatingRuleIds, setMutatingRuleIds] = useState<Set<string>>(new Set());
  const [isCreatingRule, setIsCreatingRule] = useState(false);
  const [pendingDeleteRule, setPendingDeleteRule] = useState<LowBalanceRule | null>(null);
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
  const pollingTxIdRef = useRef<string | null>(null);
  const fetchTokenBalancesRef = useRef<() => void>(() => {});
  const fetchWalletDetailsRef = useRef<() => void>(() => {});

  const updateSwapTxStatus = useCallback((txId: string, updates: Partial<SwapTx>) => {
    setSwapTransactions((prev) => prev.map((tx) => (tx.id === txId ? { ...tx, ...updates } : tx)));
  }, []);

  const invalidateWalletQueries = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['wallets'] }),
      queryClient.invalidateQueries({ queryKey: ['payment-sources-all'] }),
    ]);
  }, [queryClient]);

  const refreshWalletDetails = useCallback(async () => {
    if (!wallet || wallet.type === 'Collection') {
      setWalletDetails(null);
      return;
    }

    setIsWalletDetailsLoading(true);

    await handleApiCall(
      () =>
        getWallet({
          client: apiClient,
          query: {
            walletType: wallet.type as 'Purchasing' | 'Selling',
            id: wallet.id,
          },
        }),
      {
        onSuccess: (response) => {
          const data = response.data?.data;
          if (data) {
            setWalletDetails({
              LowBalanceSummary: data.LowBalanceSummary ?? EMPTY_LOW_BALANCE_SUMMARY,
              LowBalanceRules: data.LowBalanceRules ?? [],
            });
          }
        },
        onError: (fetchError: unknown) => {
          setWalletDetails(null);
          toast.error(extractApiErrorMessage(fetchError, 'Failed to load wallet monitoring rules'));
        },
        onFinally: () => {
          setIsWalletDetailsLoading(false);
        },
        errorMessage: 'Failed to load wallet monitoring rules',
      },
    );
  }, [apiClient, wallet]);

  const updateRuleDraft = useCallback(
    (ruleId: string, updates: Partial<RuleDraft>) => {
      setRuleDrafts((prev) => {
        const currentRule = walletDetails?.LowBalanceRules.find((rule) => rule.id === ruleId);
        const currentDraft = prev[ruleId] ?? {
          thresholdInput: currentRule
            ? getThresholdInputFromRaw(currentRule.thresholdAmount, currentRule.assetUnit, network)
            : '',
          enabled: currentRule?.enabled ?? true,
        };

        return {
          ...prev,
          [ruleId]: {
            ...currentDraft,
            ...updates,
          },
        };
      });
    },
    [network, walletDetails],
  );

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
            void fetchTokenBalances();
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
          void fetchTokenBalances();
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
        onSuccess: (response) => {
          const utxos = response.data?.data?.Utxos;
          if (utxos) {
            const balanceMap = new Map<string, number>();

            utxos.forEach((utxo) => {
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
                });
              } else {
                // For other tokens, split into policy ID and asset name
                const policyId = unit.slice(0, CARDANO_POLICY_ID_HEX_LENGTH);
                const assetNameHex = unit.slice(CARDANO_POLICY_ID_HEX_LENGTH);
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
  fetchWalletDetailsRef.current = () => {
    void refreshWalletDetails();
  };

  useEffect(() => {
    if (!walletDetails) {
      setRuleDrafts({});
      return;
    }

    setRuleDrafts(
      Object.fromEntries(
        walletDetails.LowBalanceRules.map((rule) => [
          rule.id,
          {
            thresholdInput: getThresholdInputFromRaw(rule.thresholdAmount, rule.assetUnit, network),
            enabled: rule.enabled,
          },
        ]),
      ),
    );
  }, [network, walletDetails]);

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
      // Reset states when dialog is opened
      setTokenBalances([]);
      setError(null);
      setIsLoading(true);
      setWalletDetails(null);
      setExportedMnemonic(null);
      setSwapTransactions([]);
      setSwapTxCursor(undefined);
      setHasMoreSwapTx(true);
      setNewRuleAssetPreset('lovelace');
      setNewRuleCustomAssetUnit('');
      setNewRuleThresholdInput('');
      setNewRuleEnabled(true);
      fetchTokenBalancesRef.current?.();
      fetchWalletDetailsRef.current?.();
      if (network === 'Mainnet') {
        fetchSwapTransactions();
      }
    }
  }, [isOpen, wallet?.walletAddress]);

  const usdmConfig = getUsdmConfig(network);

  const isUSDCx = (token: TokenBalance) =>
    token.policyId === USDCX_CONFIG.policyId &&
    token.assetName === hexToAscii(USDCX_CONFIG.assetName);

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

    if (isUSDCx(token)) {
      const usdcx = token.quantity / 1_000_000;
      return {
        amount: usdcx === 0 ? 'zero' : formatBalance(usdcx.toFixed(6)),
        usdValue: `≈ $${usdcx.toFixed(2)}`,
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

  const handleSaveLowBalanceRule = async (rule: LowBalanceRule) => {
    const draft = ruleDrafts[rule.id] ?? {
      thresholdInput: getThresholdInputFromRaw(rule.thresholdAmount, rule.assetUnit, network),
      enabled: rule.enabled,
    };
    const rawThresholdAmount = parseThresholdInputToRaw(
      draft.thresholdInput,
      rule.assetUnit,
      network,
    );

    if (rawThresholdAmount == null) {
      const assetMeta = getRuleAssetMeta(rule.assetUnit, network);
      toast.error(
        assetMeta.decimals == null
          ? 'Threshold amount must be a whole number in raw on-chain units.'
          : `Threshold amount must be a valid ${assetMeta.label} value with up to ${assetMeta.decimals} decimals.`,
      );
      return;
    }

    setMutatingRuleIds((prev) => new Set(prev).add(rule.id));
    const response = await handleApiCall(
      () =>
        patchWalletLowBalance({
          client: apiClient,
          body: {
            ruleId: rule.id,
            thresholdAmount: rawThresholdAmount,
            enabled: draft.enabled,
          },
        }),
      {
        onError: (mutationError: unknown) => {
          toast.error(extractApiErrorMessage(mutationError, 'Failed to update low-balance rule'));
        },
        errorMessage: 'Failed to update low-balance rule',
      },
    );
    setMutatingRuleIds((prev) => {
      const next = new Set(prev);
      next.delete(rule.id);
      return next;
    });

    if (response) {
      toast.success('Low-balance rule updated');
      await refreshWalletDetails();
      await invalidateWalletQueries();
    }
  };

  const handleDeleteLowBalanceRule = (rule: LowBalanceRule) => {
    setPendingDeleteRule(rule);
  };

  const handleConfirmDeleteLowBalanceRule = async () => {
    if (!pendingDeleteRule) {
      return;
    }

    const deleteId = pendingDeleteRule.id;
    setMutatingRuleIds((prev) => new Set(prev).add(deleteId));
    const response = await handleApiCall(
      () =>
        deleteWalletLowBalance({
          client: apiClient,
          body: {
            ruleId: deleteId,
          },
        }),
      {
        onError: (mutationError: unknown) => {
          toast.error(extractApiErrorMessage(mutationError, 'Failed to delete low-balance rule'));
        },
        errorMessage: 'Failed to delete low-balance rule',
      },
    );
    setMutatingRuleIds((prev) => {
      const next = new Set(prev);
      next.delete(deleteId);
      return next;
    });
    setPendingDeleteRule(null);

    if (response) {
      toast.success('Low-balance rule deleted');
      await refreshWalletDetails();
      await invalidateWalletQueries();
    }
  };

  const handleCreateLowBalanceRule = async () => {
    if (!wallet) return;

    const assetMeta = getRuleAssetMetaFromPreset(
      newRuleAssetPreset,
      network,
      newRuleCustomAssetUnit,
    );
    const assetUnit = assetMeta.assetUnit.trim();
    const thresholdAmount = parseThresholdInputToRaw(
      newRuleThresholdInput,
      assetMeta.assetUnit,
      network,
    );

    if (!assetUnit) {
      toast.error('Asset unit is required.');
      return;
    }

    if (thresholdAmount == null) {
      toast.error(
        assetMeta.decimals == null
          ? 'Threshold amount must be a whole number in raw on-chain units.'
          : `Threshold amount must be a valid ${assetMeta.label} value with up to ${assetMeta.decimals} decimals.`,
      );
      return;
    }

    setIsCreatingRule(true);
    const response = await handleApiCall(
      () =>
        postWalletLowBalance({
          client: apiClient,
          body: {
            walletId: wallet.id,
            assetUnit,
            thresholdAmount,
            enabled: newRuleEnabled,
          },
        }),
      {
        onError: (mutationError: unknown) => {
          toast.error(extractApiErrorMessage(mutationError, 'Failed to create low-balance rule'));
        },
        errorMessage: 'Failed to create low-balance rule',
      },
    );
    setIsCreatingRule(false);

    if (response) {
      toast.success('Low-balance rule created');
      setNewRuleAssetPreset('lovelace');
      setNewRuleCustomAssetUnit('');
      setNewRuleThresholdInput('');
      setNewRuleEnabled(true);
      await refreshWalletDetails();
      await invalidateWalletQueries();
    }
  };

  if (!wallet) return null;

  const monitoringSummary =
    walletDetails?.LowBalanceSummary ?? wallet.LowBalanceSummary ?? EMPTY_LOW_BALANCE_SUMMARY;
  const configuredRules = walletDetails?.LowBalanceRules ?? [];
  const lowRules = configuredRules.filter((rule) => rule.enabled && rule.status === 'Low');
  const enabledRuleCount = configuredRules.filter((rule) => rule.enabled).length;
  const addRuleAssetMeta = getRuleAssetMetaFromPreset(
    newRuleAssetPreset,
    network,
    newRuleCustomAssetUnit,
  );
  const newRuleAssetBreakdown = getAssetUnitBreakdown(newRuleCustomAssetUnit);
  const newRuleRawThreshold = parseThresholdInputToRaw(
    newRuleThresholdInput,
    addRuleAssetMeta.assetUnit,
    network,
  );
  const canCreateNewRule = addRuleAssetMeta.assetUnit.trim() !== '' && newRuleRawThreshold != null;

  return (
    <>
      <Dialog
        open={isOpen}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedWalletForSwap(null);
            setSelectedWalletForTopup(null);
            setPendingDeleteRule(null);
            onClose();
          }
        }}
      >
        <DialogContent
          className="sm:max-w-[600px]"
          variant={isChild ? 'slide-from-right' : 'default'}
          isPushedBack={!!selectedWalletForTopup || !!selectedWalletForSwap || !!pendingDeleteRule}
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
                  void refreshWalletDetails();
                  if (network === 'Mainnet') {
                    setSwapTxCursor(undefined);
                    fetchSwapTransactions();
                  }
                }}
                disabled={isLoading || isWalletDetailsLoading}
              >
                <RefreshCw
                  className={`h-4 w-4 ${isLoading || isWalletDetailsLoading ? 'animate-spin' : ''}`}
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
              <section
                className={`space-y-4 rounded-xl border p-4 ${
                  monitoringSummary.isLow
                    ? 'border-amber-500/40 bg-amber-500/10'
                    : 'border-border bg-muted/40'
                }`}
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-semibold">Low Balance Monitoring</h3>
                      <Badge variant={monitoringSummary.isLow ? 'destructive' : 'secondary'}>
                        {monitoringSummary.isLow
                          ? `${monitoringSummary.lowRuleCount} warning${monitoringSummary.lowRuleCount === 1 ? '' : 's'}`
                          : enabledRuleCount > 0
                            ? `${enabledRuleCount} active`
                            : 'Not configured'}
                      </Badge>
                    </div>
                    <p className="max-w-xl text-xs leading-relaxed text-muted-foreground">
                      New wallets inherit default monitoring rules automatically. Supported assets
                      are edited in human units here and converted to on-chain quantities when
                      saved. Custom assets show the underlying policy ID and asset-name hex parts.
                    </p>
                  </div>
                  <div className="grid min-w-0 grid-cols-3 gap-2 sm:min-w-[260px]">
                    <div className="rounded-lg border bg-background/70 px-3 py-2">
                      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                        Rules
                      </div>
                      <div className="mt-1 text-lg font-semibold">{configuredRules.length}</div>
                    </div>
                    <div className="rounded-lg border bg-background/70 px-3 py-2">
                      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                        Low
                      </div>
                      <div className="mt-1 text-lg font-semibold">{lowRules.length}</div>
                    </div>
                    <div className="rounded-lg border bg-background/70 px-3 py-2">
                      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                        Checked
                      </div>
                      <div className="mt-1 text-xs font-medium text-foreground">
                        {monitoringSummary.lastCheckedAt
                          ? monitoringSummary.lastCheckedAt.toLocaleTimeString([], {
                              hour: '2-digit',
                              minute: '2-digit',
                            })
                          : 'Never'}
                      </div>
                    </div>
                  </div>
                </div>

                {monitoringSummary.lastCheckedAt && (
                  <div className="text-xs text-muted-foreground">
                    Last full check {monitoringSummary.lastCheckedAt.toLocaleString()}
                  </div>
                )}

                {isWalletDetailsLoading ? (
                  <div className="flex justify-center py-6">
                    <Spinner size={18} />
                  </div>
                ) : (
                  <>
                    {lowRules.length > 0 && (
                      <div className="space-y-2">
                        {lowRules.map((rule) => (
                          <div
                            key={`low-warning-${rule.id}`}
                            className="rounded-lg border border-amber-500/40 bg-background/80 px-4 py-3"
                          >
                            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                              <div className="flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-400">
                                <AlertTriangle className="h-4 w-4 shrink-0" />
                                <span>
                                  {getRuleAssetLabel(rule.assetUnit, network)} dropped below
                                  threshold
                                </span>
                              </div>
                              <Badge variant="destructive" className="w-fit">
                                {formatRuleAmount(rule.lastKnownAmount, rule.assetUnit, network)}
                              </Badge>
                            </div>
                            <div className="mt-2 grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
                              <div>
                                Threshold:{' '}
                                <span className="text-foreground">
                                  {formatRuleAmount(rule.thresholdAmount, rule.assetUnit, network)}
                                </span>
                              </div>
                              <div>
                                Asset unit:{' '}
                                <span className="font-mono text-foreground">
                                  {shortenAddress(rule.assetUnit, 8)}
                                </span>
                              </div>
                              <div>
                                Last warning:{' '}
                                <span className="text-foreground">
                                  {rule.lastAlertedAt
                                    ? rule.lastAlertedAt.toLocaleString()
                                    : 'Not sent'}
                                </span>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    <div className="space-y-3">
                      {configuredRules.length === 0 ? (
                        <div className="rounded-lg border border-dashed bg-background/70 p-4 text-sm text-muted-foreground">
                          No low-balance rules configured for this wallet yet.
                        </div>
                      ) : (
                        configuredRules.map((rule) => {
                          const assetMeta = getRuleAssetMeta(rule.assetUnit, network);
                          const assetBreakdown = getAssetUnitBreakdown(rule.assetUnit);
                          const draft = ruleDrafts[rule.id] ?? {
                            thresholdInput: getThresholdInputFromRaw(
                              rule.thresholdAmount,
                              rule.assetUnit,
                              network,
                            ),
                            enabled: rule.enabled,
                          };
                          const draftRawThreshold = parseThresholdInputToRaw(
                            draft.thresholdInput,
                            rule.assetUnit,
                            network,
                          );
                          const hasChanges =
                            draftRawThreshold !== rule.thresholdAmount ||
                            draft.enabled !== rule.enabled;
                          const isMutating = mutatingRuleIds.has(rule.id);

                          return (
                            <div
                              key={rule.id}
                              className={`rounded-xl border bg-background/75 p-4 ${
                                rule.enabled && rule.status === 'Low'
                                  ? 'border-amber-500/40'
                                  : 'border-border'
                              }`}
                            >
                              <div className="flex flex-col gap-3">
                                <div className="flex items-start justify-between gap-3">
                                  <div className="min-w-0 space-y-1">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <span className="text-sm font-semibold">
                                        {assetMeta.label}
                                      </span>
                                      <Badge
                                        variant={
                                          !rule.enabled
                                            ? 'outline'
                                            : rule.status === 'Low'
                                              ? 'destructive'
                                              : 'secondary'
                                        }
                                      >
                                        {!rule.enabled ? 'Disabled' : rule.status}
                                      </Badge>
                                    </div>
                                    <div className="text-xs text-muted-foreground">
                                      {assetMeta.helperText}
                                    </div>
                                    <div className="font-mono text-[11px] leading-relaxed text-muted-foreground break-all">
                                      {rule.assetUnit}
                                    </div>
                                  </div>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-8 w-8 shrink-0"
                                    onClick={() => handleDeleteLowBalanceRule(rule)}
                                    disabled={isMutating}
                                  >
                                    {isMutating ? (
                                      <Spinner size={12} />
                                    ) : (
                                      <X className="h-3.5 w-3.5" />
                                    )}
                                  </Button>
                                </div>

                                <div className="grid gap-2 sm:grid-cols-3">
                                  <div className="rounded-lg border bg-muted/30 px-3 py-2">
                                    <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                                      Current
                                    </div>
                                    <div className="mt-1 text-sm font-medium">
                                      {formatRuleAmount(
                                        rule.lastKnownAmount,
                                        rule.assetUnit,
                                        network,
                                      )}
                                    </div>
                                  </div>
                                  <div className="rounded-lg border bg-muted/30 px-3 py-2">
                                    <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                                      Threshold
                                    </div>
                                    <div className="mt-1 text-sm font-medium">
                                      {formatRuleAmount(
                                        rule.thresholdAmount,
                                        rule.assetUnit,
                                        network,
                                      )}
                                    </div>
                                  </div>
                                  <div className="rounded-lg border bg-muted/30 px-3 py-2">
                                    <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                                      Last warning
                                    </div>
                                    <div className="mt-1 text-sm font-medium">
                                      {rule.lastAlertedAt
                                        ? rule.lastAlertedAt.toLocaleString()
                                        : 'None'}
                                    </div>
                                  </div>
                                </div>

                                {assetMeta.decimals == null && (
                                  <div className="grid gap-2 rounded-lg border bg-muted/20 p-3 sm:grid-cols-3">
                                    <div>
                                      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                                        Policy ID
                                      </div>
                                      <div className="mt-1 font-mono text-xs break-all">
                                        {assetBreakdown.policyId || 'Missing'}
                                      </div>
                                    </div>
                                    <div>
                                      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                                        Asset Name Hex
                                      </div>
                                      <div className="mt-1 font-mono text-xs break-all">
                                        {assetBreakdown.assetNameHex || 'Empty'}
                                      </div>
                                    </div>
                                    <div>
                                      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                                        Decoded Name
                                      </div>
                                      <div className="mt-1 text-xs font-medium">
                                        {assetBreakdown.decodedAssetName || 'Unavailable'}
                                      </div>
                                    </div>
                                  </div>
                                )}

                                <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_200px_auto] lg:items-end">
                                  <div className="space-y-1.5">
                                    <div className="text-xs text-muted-foreground">
                                      {assetMeta.inputLabel}
                                    </div>
                                    <Input
                                      value={draft.thresholdInput}
                                      onChange={(event) =>
                                        updateRuleDraft(rule.id, {
                                          thresholdInput: event.target.value,
                                        })
                                      }
                                      placeholder={assetMeta.decimals != null ? '5.0' : '5000000'}
                                    />
                                    <div className="text-[11px] text-muted-foreground">
                                      Stored raw amount:{' '}
                                      <span className="font-mono text-foreground">
                                        {draftRawThreshold ?? 'Invalid input'}
                                      </span>
                                    </div>
                                  </div>
                                  <div className="rounded-lg border px-3 py-2">
                                    <div className="flex items-center justify-between gap-3">
                                      <div>
                                        <div className="text-xs font-medium">Enabled</div>
                                        <div className="text-[11px] text-muted-foreground">
                                          Toggle monitoring for this asset
                                        </div>
                                      </div>
                                      <Switch
                                        checked={draft.enabled}
                                        onCheckedChange={(checked) =>
                                          updateRuleDraft(rule.id, { enabled: checked })
                                        }
                                      />
                                    </div>
                                  </div>
                                  <Button
                                    variant="outline"
                                    className="w-full lg:w-auto"
                                    onClick={() => handleSaveLowBalanceRule(rule)}
                                    disabled={
                                      !hasChanges || isMutating || draftRawThreshold == null
                                    }
                                  >
                                    {isMutating ? <Spinner size={16} /> : 'Save'}
                                  </Button>
                                </div>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>

                    <div className="rounded-xl border border-dashed bg-background/70 p-4">
                      <div className="flex flex-col gap-1">
                        <h4 className="text-sm font-semibold">Add monitoring rule</h4>
                        <p className="text-xs text-muted-foreground">
                          Pick a common asset or switch to custom for a full policy+asset unit.
                        </p>
                      </div>

                      <div className="mt-4 grid gap-3 lg:grid-cols-[220px_minmax(0,1fr)]">
                        <div className="space-y-1.5">
                          <div className="text-xs text-muted-foreground">Asset</div>
                          <Select
                            value={newRuleAssetPreset}
                            onValueChange={(value) => {
                              setNewRuleAssetPreset(value as RuleAssetPreset);
                              setNewRuleThresholdInput('');
                            }}
                          >
                            <SelectTrigger>
                              <SelectValue placeholder="Select asset" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="lovelace">ADA</SelectItem>
                              <SelectItem value="stablecoin">
                                {network === 'Mainnet' ? 'USDCx' : 'tUSDM'}
                              </SelectItem>
                              <SelectItem value="custom">Custom asset</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>

                        <div className="space-y-1.5">
                          <div className="text-xs text-muted-foreground">
                            {addRuleAssetMeta.inputLabel}
                          </div>
                          <Input
                            value={newRuleThresholdInput}
                            onChange={(event) => setNewRuleThresholdInput(event.target.value)}
                            placeholder={addRuleAssetMeta.decimals != null ? '5.0' : '5000000'}
                          />
                          <div className="text-[11px] text-muted-foreground">
                            {addRuleAssetMeta.decimals != null
                              ? `Will be stored with ${addRuleAssetMeta.decimals} decimals for ${addRuleAssetMeta.label}.`
                              : addRuleAssetMeta.helperText}
                          </div>
                        </div>
                      </div>

                      {newRuleAssetPreset === 'custom' && (
                        <div className="mt-3 space-y-3">
                          <div className="space-y-1.5">
                            <div className="text-xs text-muted-foreground">Custom asset unit</div>
                            <Input
                              value={newRuleCustomAssetUnit}
                              onChange={(event) => setNewRuleCustomAssetUnit(event.target.value)}
                              placeholder="policyidassetnamehex"
                            />
                            <div className="text-[11px] leading-relaxed text-muted-foreground">
                              Format:{' '}
                              <span className="font-mono text-foreground">
                                policyId + assetNameHex
                              </span>
                              . Example field shape:{' '}
                              <span className="font-mono text-foreground">
                                policyidassetnamehex
                              </span>
                            </div>
                          </div>

                          <div className="grid gap-2 rounded-lg border bg-muted/20 p-3 sm:grid-cols-3">
                            <div>
                              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                                Policy ID
                              </div>
                              <div className="mt-1 font-mono text-xs break-all">
                                {newRuleAssetBreakdown.policyId || 'Enter asset unit'}
                              </div>
                            </div>
                            <div>
                              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                                Asset Name Hex
                              </div>
                              <div className="mt-1 font-mono text-xs break-all">
                                {newRuleAssetBreakdown.assetNameHex || 'Enter asset unit'}
                              </div>
                            </div>
                            <div>
                              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                                Decoded Name
                              </div>
                              <div className="mt-1 text-xs font-medium">
                                {newRuleAssetBreakdown.decodedAssetName || 'Unavailable'}
                              </div>
                            </div>
                          </div>
                        </div>
                      )}

                      <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_200px_auto] lg:items-end">
                        <div className="rounded-lg border bg-muted/20 px-3 py-2">
                          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                            Raw amount preview
                          </div>
                          <div className="mt-1 font-mono text-sm">
                            {newRuleThresholdInput.trim() === ''
                              ? 'Enter amount'
                              : (newRuleRawThreshold ?? 'Invalid input')}
                          </div>
                        </div>
                        <div className="rounded-lg border px-3 py-2">
                          <div className="flex items-center justify-between gap-3">
                            <div>
                              <div className="text-xs font-medium">Enabled</div>
                              <div className="text-[11px] text-muted-foreground">
                                Start monitoring immediately
                              </div>
                            </div>
                            <Switch checked={newRuleEnabled} onCheckedChange={setNewRuleEnabled} />
                          </div>
                        </div>
                        <Button
                          className="w-full lg:w-auto"
                          onClick={handleCreateLowBalanceRule}
                          disabled={isCreatingRule || !canCreateNewRule}
                        >
                          {isCreatingRule ? <Spinner size={16} /> : 'Add rule'}
                        </Button>
                      </div>
                    </div>
                  </>
                )}
              </section>
            )}

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
                  {/* Sort tokens: ADA first, then USDCx, then USDM (legacy), then others */}
                  {(() => {
                    const adaToken = tokenBalances.find((t) => t.unit === 'lovelace');
                    const usdcxToken = tokenBalances.find((t) => isUSDCx(t));
                    const usdmToken = tokenBalances.find((t) => isUSDM(t));
                    const otherTokens = tokenBalances.filter(
                      (t) => t.unit !== 'lovelace' && !isUSDCx(t) && !isUSDM(t),
                    );
                    const sortedTokens = [adaToken, usdcxToken, usdmToken, ...otherTokens].filter(
                      (t): t is TokenBalance => Boolean(t),
                    );

                    return sortedTokens.map((token) => {
                      const { amount, usdValue } = formatTokenBalance(token);
                      const isADA = token.unit === 'lovelace';
                      const isUsdcx = isUSDCx(token);
                      const isUsdm = isUSDM(token);
                      const assetHex = !isADA ? token.unit.slice(CARDANO_POLICY_ID_HEX_LENGTH) : '';

                      let displayName: string;
                      if (isADA) {
                        displayName = 'ADA';
                      } else if (isUsdcx) {
                        displayName = `USDCx (${shortenAddress(token.policyId)})`;
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
                        !isADA && !isUsdcx && !isUsdm
                          ? getExplorerUrl(token.unit, network, 'token')
                          : undefined;

                      const inner = (
                        <>
                          <div>
                            <div className="font-medium font-mono">{displayName}</div>
                            {!isUsdcx && !isUsdm && token.policyId && (
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

      <ConfirmDialog
        open={!!pendingDeleteRule}
        onClose={() => setPendingDeleteRule(null)}
        title={
          pendingDeleteRule
            ? `Delete ${getRuleAssetLabel(pendingDeleteRule.assetUnit, network)} rule?`
            : 'Delete low-balance rule?'
        }
        description={
          pendingDeleteRule
            ? getDeleteRuleDialogDescription(pendingDeleteRule, network)
            : 'Remove this low-balance rule?'
        }
        onConfirm={handleConfirmDeleteLowBalanceRule}
        isLoading={pendingDeleteRule != null && mutatingRuleIds.has(pendingDeleteRule.id)}
      />

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
