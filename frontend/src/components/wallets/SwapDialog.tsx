/* eslint-disable react-hooks/exhaustive-deps */

import { useEffect, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import swappableTokens from '@/assets/swappableTokens.json';
import { ArrowDownUp, Check, ChevronDown, ExternalLink, RefreshCw } from 'lucide-react';
import { getSwapConfirm, getUtxos, postSwap } from '@/lib/api/generated';
import { useAppContext } from '@/lib/contexts/AppContext';
import { toast } from 'react-toastify';
import BlinkingUnderscore from '../BlinkingUnderscore';
import { shortenAddress, handleApiCall, getExplorerUrl } from '@/lib/utils';
import { Spinner } from '../ui/spinner';
import formatBalance from '@/lib/formatBalance';
import Image from 'next/image';
import { getUsdmConfig } from '@/lib/constants/defaultWallets';
import { CopyButton } from '@/components/ui/copy-button';
import adaIcon from '@/assets/ada.png';
import usdmIcon from '@/assets/usdm.png';
import nmkrIcon from '@/assets/nmkr.png';
import usdcxIcon from '@/assets/usdcx.png';

interface SwapDialogProps {
  isOpen: boolean;
  onClose: () => void;
  walletAddress: string;
  walletVkey: string;
  network: 'Preprod' | 'Mainnet';
  onSwapComplete?: () => void;
}

const TOKEN_ICONS: Record<string, typeof adaIcon> = {
  ADA: adaIcon,
  USDM: usdmIcon,
  USDCx: usdcxIcon,
  NMKR: nmkrIcon,
};

function TokenSelector({
  selectedToken,
  onSelect,
  disabled,
}: {
  selectedToken: (typeof swappableTokens)[number];
  onSelect: (index: number) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => !disabled && setOpen(!open)}
        disabled={disabled}
        className="flex items-center gap-2 rounded-xl bg-background/60 border border-border/50 px-3 py-2 text-sm font-medium whitespace-nowrap hover:bg-background/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <Image
          src={TOKEN_ICONS[selectedToken.symbol] || adaIcon}
          alt={selectedToken.symbol}
          className="rounded-full"
          width={22}
          height={22}
        />
        <span>{selectedToken.symbol}</span>
        <ChevronDown
          className={`h-3.5 w-3.5 text-muted-foreground transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full mt-1 z-50 min-w-[160px] rounded-xl border border-border bg-popover p-1 shadow-lg">
            {swappableTokens.map((token, index) => (
              <button
                key={token.symbol}
                type="button"
                onClick={() => {
                  onSelect(index);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm whitespace-nowrap hover:bg-accent transition-colors"
              >
                <Image
                  src={TOKEN_ICONS[token.symbol] || adaIcon}
                  alt={token.symbol}
                  className="rounded-full"
                  width={20}
                  height={20}
                />
                <span className="font-medium">{token.symbol}</span>
                <span className="ml-auto text-xs text-muted-foreground">{token.name}</span>
                {token.symbol === selectedToken.symbol && (
                  <Check className="h-3.5 w-3.5 text-primary" />
                )}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function SwapDialog({
  isOpen,
  onClose,
  walletAddress,
  walletVkey,
  network,
  onSwapComplete,
}: SwapDialogProps) {
  const { apiKey, apiClient } = useAppContext();
  const [adaBalance, setAdaBalance] = useState<number>(0);
  const [usdmBalance, setUsdmBalance] = useState<number>(0);
  const [otherTokenBalances, setOtherTokenBalances] = useState<Record<string, number>>({});
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [fromAmount, setFromAmount] = useState<number>(1);
  const [adaToUsdRate, setAdaToUsdRate] = useState<number>(0);
  const [isFetchingDetails, setIsFetchingDetails] = useState<boolean>(true);
  const [isSwapping, setIsSwapping] = useState<boolean>(false);
  const [showConfirmation, setShowConfirmation] = useState<boolean>(false);
  const [txHash, setTxHash] = useState<string | null>(null);

  const adaIndex = swappableTokens.findIndex((token) => token.symbol === 'ADA');
  const usdmIndex = swappableTokens.findIndex((token) => token.symbol === 'USDM');

  const [selectedFromToken, setSelectedFromToken] = useState(swappableTokens[adaIndex]);
  const [selectedToToken, setSelectedToToken] = useState(swappableTokens[usdmIndex]);

  const [tokenRates, setTokenRates] = useState<Record<string, number>>({});

  const [swapStatus, setSwapStatus] = useState<'idle' | 'processing' | 'submitted' | 'confirmed'>(
    'idle',
  );

  const pollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollCancelledRef = useRef(false);

  const fetchTokenRates = async () => {
    try {
      const response = await fetch(
        'https://api.coingecko.com/api/v3/simple/price?ids=cardano&vs_currencies=usd',
      );
      const data = await response.json();
      setAdaToUsdRate(data?.cardano?.usd || 0);

      const rates: Record<string, number> = {};
      for (const token of swappableTokens) {
        if (token.symbol !== 'ADA' && token.policyId && token.hexedAssetName) {
          const url = `https://dhapi.io/swap/averagePrice/ADA/${token.policyId}${token.hexedAssetName}`;
          try {
            const response = await fetch(url);
            const data = await response.json();
            rates[token.symbol] = data.price_ab || 0;
          } catch (error) {
            console.error(`Failed to fetch rate for ${token.symbol}`, error);
            rates[token.symbol] = 0;
          }
        }
      }
      setTokenRates(rates);
    } catch (error) {
      console.error('Failed to fetch rates', error);
    }
  };

  useEffect(() => {
    if (isOpen) {
      setIsFetchingDetails(true);
      setTxHash(null);
      setError(null);
      setSwapStatus('idle');
      setIsSwapping(false);
      setShowConfirmation(false);
      fetchBalance();
      fetchTokenRates();

      const balanceInterval = setInterval(() => {
        fetchBalance();
      }, 20000);

      return () => {
        clearInterval(balanceInterval);
        pollCancelledRef.current = true;
        if (pollTimeoutRef.current) {
          clearTimeout(pollTimeoutRef.current);
          pollTimeoutRef.current = null;
        }
      };
    }
  }, [isOpen]);

  const fetchBalance = async () => {
    try {
      const result = await getUtxos({
        client: apiClient,
        headers: {
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          Pragma: 'no-cache',
          Expires: '0',
        },
        query: {
          address: walletAddress,
          network: network,
        },
      });
      const lovelace =
        result?.data?.data?.Utxos?.reduce((acc, utxo) => {
          return (
            acc +
            utxo.Amounts.reduce((acc, asset) => {
              if (asset.unit === 'lovelace' || asset.unit === '') {
                return acc + (asset.quantity ?? 0);
              }
              return acc;
            }, 0)
          );
        }, 0) ?? 0;
      const usdmConfig = getUsdmConfig(network);
      const usdm =
        result?.data?.data?.Utxos?.reduce((acc, utxo) => {
          return (
            acc +
            utxo.Amounts.reduce((acc, asset) => {
              if (asset.unit === usdmConfig.fullAssetId) {
                return acc + (asset.quantity ?? 0);
              }
              return acc;
            }, 0)
          );
        }, 0) ?? 0;

      const others: Record<string, number> = {};
      for (const token of swappableTokens) {
        if (token.symbol === 'ADA' || token.symbol === 'USDM') continue;
        if (!token.policyId || !token.hexedAssetName || token.hexedAssetName === 'NATIVE') continue;
        const fullUnit = token.policyId + token.hexedAssetName;
        const sum =
          result?.data?.data?.Utxos?.reduce((acc, utxo) => {
            return (
              acc +
              utxo.Amounts.reduce((acc, asset) => {
                if (asset.unit === fullUnit) {
                  return acc + (asset.quantity ?? 0);
                }
                return acc;
              }, 0)
            );
          }, 0) ?? 0;
        const decimals = (token as { decimals?: number }).decimals ?? 6;
        others[token.symbol] = sum / Math.pow(10, decimals);
      }

      const adaDecimals = swappableTokens.find((t) => t.symbol === 'ADA')?.decimals ?? 6;
      const usdmDecimals = swappableTokens.find((t) => t.symbol === 'USDM')?.decimals ?? 6;
      setAdaBalance(lovelace / Math.pow(10, adaDecimals));
      setUsdmBalance(usdm / Math.pow(10, usdmDecimals));
      setOtherTokenBalances(others);
      setBalanceError(null);
    } catch (error) {
      console.error('Failed to fetch balance', error);
      setBalanceError('Failed to fetch balance');
    } finally {
      setIsFetchingDetails(false);
    }
  };

  const canSwap =
    adaBalance > 0 &&
    selectedFromToken.symbol !== selectedToToken.symbol &&
    network === 'Mainnet' &&
    !!walletVkey;

  const handleSwitch = () => {
    if (selectedFromToken.symbol === 'ADA' || selectedToToken.symbol === 'ADA') {
      setSelectedFromToken(selectedToToken);
      setSelectedToToken(selectedFromToken);
    }
  };

  const handleTokenChange = (type: 'from' | 'to', tokenIndex: number) => {
    const selectedToken = swappableTokens[tokenIndex];

    if (type === 'from') {
      setSelectedFromToken(selectedToken);
      if (selectedToken.symbol !== 'ADA' && selectedToToken.symbol !== 'ADA') {
        setSelectedToToken(swappableTokens[adaIndex]);
      } else if (selectedToken.symbol === selectedToToken.symbol) {
        setSelectedToToken(selectedFromToken);
      }
    } else {
      setSelectedToToken(selectedToken);
      if (selectedToken.symbol !== 'ADA' && selectedFromToken.symbol !== 'ADA') {
        setSelectedFromToken(swappableTokens[adaIndex]);
      } else if (selectedToken.symbol === selectedFromToken.symbol) {
        setSelectedFromToken(selectedToToken);
      }
    }
  };

  const getBalanceForToken = (tokenSymbol: string) => {
    switch (tokenSymbol) {
      case 'ADA':
        return adaBalance;
      case 'USDM':
        return usdmBalance;
      default:
        return otherTokenBalances[tokenSymbol] ?? 0;
    }
  };

  const getMaxAmount = (tokenSymbol: string) => {
    const balance = getBalanceForToken(tokenSymbol);
    if (tokenSymbol === 'ADA') {
      return Math.max(0, balance - 3);
    }
    return balance;
  };

  const handleMaxClick = () => {
    setFromAmount(getMaxAmount(selectedFromToken.symbol));
  };

  const handleFromAmountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    const filteredValue = value.replace(/[^0-9.]/g, '');
    const parsedValue = parseFloat(filteredValue);
    const normalizedValue = isNaN(parsedValue) ? 0 : Number(parsedValue);
    setFromAmount(normalizedValue);
  };

  const getConversionRate = () => {
    if (selectedFromToken.symbol === 'ADA') {
      return tokenRates[selectedToToken.symbol] || 0;
    } else if (selectedToToken.symbol === 'ADA') {
      return 1 / (tokenRates[selectedFromToken.symbol] || 1);
    } else {
      const fromTokenInAda = tokenRates[selectedFromToken.symbol] || 0;
      const toTokenInAda = tokenRates[selectedToToken.symbol] || 0;
      return toTokenInAda > 0 ? fromTokenInAda / toTokenInAda : 0;
    }
  };

  const conversionRate = getConversionRate();
  const toAmount = fromAmount * conversionRate;

  const STABLECOIN_SYMBOLS = ['USDM', 'USDCx'];
  const fromIsStablecoin = STABLECOIN_SYMBOLS.includes(selectedFromToken.symbol);
  const toIsAda = selectedToToken.symbol === 'ADA';
  const formattedDollarValue = fromIsStablecoin
    ? `~$${fromAmount.toFixed(2)}`
    : toIsAda
      ? `$${(toAmount * adaToUsdRate).toFixed(2)}`
      : `$${toAmount.toFixed(2)}`;

  const formattedFromBalance = formatBalance(
    getBalanceForToken(selectedFromToken.symbol).toFixed(6),
  );

  const formattedToBalance = formatBalance(getBalanceForToken(selectedToToken.symbol).toFixed(6));

  const handleSwapClick = () => {
    setTxHash(null);
    setShowConfirmation(true);
  };

  const handleConfirmSwap = async () => {
    setShowConfirmation(false);
    setIsSwapping(true);
    setError(null);
    setSwapStatus('processing');

    try {
      if (!walletVkey) {
        throw new Error('Wallet verification key not available');
      }

      if (!apiKey) {
        throw new Error('API key not found');
      }

      const poolId = selectedFromToken.poolId || selectedToToken.poolId || '';

      if (!poolId) {
        throw new Error('Pool ID not found for selected tokens');
      }

      type SwappableToken = (typeof swappableTokens)[number] & { hexedAssetName?: string };
      const assetNameForApi = (token: SwappableToken): string => {
        if (token.assetName === 'ADA' || token.assetName === 'NATIVE') return '';
        if (token.hexedAssetName && token.hexedAssetName !== 'NATIVE') return token.hexedAssetName;
        return token.assetName || '';
      };

      const fromToken = {
        policyId:
          selectedFromToken.policyId === 'NATIVE' || selectedFromToken.policyId === ''
            ? ''
            : selectedFromToken.policyId || '',
        assetName: assetNameForApi(selectedFromToken as SwappableToken),
        name: selectedFromToken.name || selectedFromToken.symbol,
      };

      const toToken = {
        policyId:
          selectedToToken.policyId === 'NATIVE' || selectedToToken.policyId === ''
            ? ''
            : selectedToToken.policyId || '',
        assetName: assetNameForApi(selectedToToken as SwappableToken),
        name: selectedToToken.name || selectedToToken.symbol,
      };

      const response = await handleApiCall(
        () =>
          postSwap({
            client: apiClient,
            body: {
              walletVkey,
              amount: fromAmount,
              fromToken,
              toToken,
              poolId,
              slippage: 0.03,
            },
          }),
        {
          onSuccess: async (result) => {
            const transactionHash =
              (result as any)?.data?.data?.txHash || (result as any)?.data?.txHash;

            if (transactionHash) {
              setTxHash(transactionHash);
            }

            setSwapStatus('submitted');
            toast.info('Swap transaction submitted! Waiting for on-chain confirmation…', {
              theme: 'dark',
            });

            if (transactionHash && walletVkey) {
              const POLL_INTERVAL_MS = 4000;
              const MAX_POLL_MS = 5 * 60 * 1000; // 5 minutes
              const startedAt = Date.now();
              pollCancelledRef.current = false;
              if (pollTimeoutRef.current) {
                clearTimeout(pollTimeoutRef.current);
                pollTimeoutRef.current = null;
              }

              const poll = async (): Promise<void> => {
                if (pollCancelledRef.current) return;
                if (Date.now() - startedAt > MAX_POLL_MS) {
                  if (pollCancelledRef.current) return;
                  toast.warning(
                    'Confirmation is taking longer than expected. You can check the transaction in the explorer.',
                    { theme: 'dark' },
                  );
                  setIsSwapping(false);
                  pollTimeoutRef.current = setTimeout(() => {
                    if (!pollCancelledRef.current) setSwapStatus('idle');
                  }, 2000);
                  return;
                }
                try {
                  const confirmResult = await getSwapConfirm({
                    client: apiClient,
                    query: { txHash: transactionHash, walletVkey },
                  });
                  if (pollCancelledRef.current) return;
                  const data = (confirmResult as any)?.data?.data ?? (confirmResult as any)?.data;
                  const status = data?.status;
                  if (status === 'confirmed') {
                    if (pollCancelledRef.current) return;
                    await fetchBalance();
                    if (pollCancelledRef.current) return;
                    onSwapComplete?.();
                    setSwapStatus('confirmed');
                    toast.success('Swap confirmed on-chain.', { theme: 'dark' });
                    setIsSwapping(false);
                    pollTimeoutRef.current = setTimeout(() => {
                      if (!pollCancelledRef.current) setSwapStatus('idle');
                    }, 2000);
                    return;
                  }
                  pollTimeoutRef.current = setTimeout(poll, POLL_INTERVAL_MS);
                } catch {
                  if (!pollCancelledRef.current) {
                    pollTimeoutRef.current = setTimeout(poll, POLL_INTERVAL_MS);
                  }
                }
              };
              pollTimeoutRef.current = setTimeout(poll, POLL_INTERVAL_MS);
            } else {
              toast.warning('Swap submitted but confirmation unavailable (missing tx hash).', {
                theme: 'dark',
              });
              await fetchBalance();
              setIsSwapping(false);
              if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current);
              pollTimeoutRef.current = setTimeout(() => {
                if (!pollCancelledRef.current) setSwapStatus('idle');
              }, 2000);
            }
          },
          onError: (error: any) => {
            setError(error?.error?.message || 'Swap failed');
            setIsSwapping(false);
            setSwapStatus('idle');
          },
          errorMessage: 'Swap failed',
        },
      );

      if (!response) {
        return;
      }
    } catch (error: any) {
      const errorMessage = error?.message || 'Swap failed';
      toast.error(`Swap failed: ${errorMessage}`, { theme: 'dark' });
      setError(errorMessage);
      setIsSwapping(false);
      setSwapStatus('idle');
    }
  };

  const isOverMax = fromAmount > getMaxAmount(selectedFromToken.symbol);

  const statusLabel =
    swapStatus === 'processing'
      ? 'Signing transaction...'
      : swapStatus === 'submitted'
        ? 'Waiting for confirmation...'
        : swapStatus === 'confirmed'
          ? 'Swap confirmed!'
          : null;

  const statusColor =
    swapStatus === 'processing'
      ? 'text-orange-400'
      : swapStatus === 'submitted'
        ? 'text-blue-400'
        : swapStatus === 'confirmed'
          ? 'text-green-400'
          : '';

  const progressWidth =
    swapStatus === 'processing'
      ? '20%'
      : swapStatus === 'submitted'
        ? '66%'
        : swapStatus === 'confirmed'
          ? '100%'
          : '0%';

  const progressColor =
    swapStatus === 'processing'
      ? 'bg-orange-500'
      : swapStatus === 'submitted'
        ? 'bg-blue-500'
        : swapStatus === 'confirmed'
          ? 'bg-green-500'
          : 'bg-transparent';

  return (
    <>
      <Dialog
        open={isOpen && !showConfirmation}
        onOpenChange={(open) => {
          if (!open) {
            setShowConfirmation(false);
            onClose();
          }
        }}
      >
        <DialogContent className="sm:max-w-[440px] overflow-y-hidden p-0 gap-0 border-border/50">
          {/* Header */}
          <div className="flex items-center justify-between px-5 pt-10 pb-3">
            <div>
              <DialogHeader className="space-y-0.5">
                <DialogTitle className="text-base">Swap</DialogTitle>
                <DialogDescription className="text-xs">
                  {shortenAddress(walletAddress, 6)}
                </DialogDescription>
              </DialogHeader>
            </div>
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8 rounded-lg"
              onClick={() => {
                setIsFetchingDetails(true);
                fetchBalance();
              }}
              disabled={isFetchingDetails || isSwapping}
              title="Refresh balance"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isFetchingDetails ? 'animate-spin' : ''}`} />
            </Button>
          </div>

          {isFetchingDetails ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground">
              <BlinkingUnderscore />
            </div>
          ) : network?.toLowerCase() !== 'mainnet' ? (
            <div className="px-5 pb-5 text-sm text-destructive">
              Swap is only available on <span className="font-medium">Mainnet</span>
            </div>
          ) : (
            <div className="px-5 pb-5">
              <div
                className={`transition-opacity duration-200 ${isSwapping ? 'opacity-40 pointer-events-none' : ''}`}
              >
                {/* From panel */}
                <div className="rounded-xl bg-secondary/70 p-4 border border-border/30">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      You pay
                    </span>
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <span>Balance: {formattedFromBalance}</span>
                      <button
                        type="button"
                        onClick={handleMaxClick}
                        className="text-primary hover:text-primary/80 font-medium transition-colors"
                      >
                        MAX
                      </button>
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <TokenSelector
                      selectedToken={selectedFromToken}
                      onSelect={(i) => handleTokenChange('from', i)}
                      disabled={isSwapping}
                    />
                    <input
                      type="number"
                      className={`w-full text-right bg-transparent focus:outline-none text-2xl font-semibold tabular-nums tracking-tight ${
                        isOverMax ? 'text-destructive' : 'text-foreground'
                      }`}
                      placeholder="0"
                      value={fromAmount || ''}
                      onChange={handleFromAmountChange}
                      step="0.1"
                    />
                  </div>
                  <div className="text-right text-xs text-muted-foreground mt-1.5">
                    {formattedDollarValue}
                  </div>
                </div>

                {/* Swap direction button */}
                <div className="flex justify-center -my-3 relative z-10">
                  <button
                    type="button"
                    onClick={handleSwitch}
                    className="flex items-center justify-center h-9 w-9 rounded-xl bg-secondary border-[3px] border-background hover:bg-accent transition-all duration-150 active:scale-90"
                  >
                    <ArrowDownUp className="h-3.5 w-3.5 text-muted-foreground" />
                  </button>
                </div>

                {/* To panel */}
                <div className="rounded-xl bg-secondary/40 p-4 border border-border/20">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      You receive
                    </span>
                    <span className="text-xs text-muted-foreground">
                      Balance: {formattedToBalance}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <TokenSelector
                      selectedToken={selectedToToken}
                      onSelect={(i) => handleTokenChange('to', i)}
                      disabled={isSwapping}
                    />
                    <span className="w-full text-right text-2xl font-semibold tabular-nums tracking-tight text-foreground/70">
                      {toAmount > 0 ? toAmount.toFixed(6) : '0'}
                    </span>
                  </div>
                </div>

                {/* Rate info */}
                {conversionRate > 0 && (
                  <div className="flex items-center justify-center gap-1.5 mt-3 text-xs text-muted-foreground">
                    <span>
                      1 {selectedFromToken.symbol} = {conversionRate.toFixed(5)}{' '}
                      {selectedToToken.symbol}
                    </span>
                    <span className="text-border">|</span>
                    <span>3% slippage</span>
                  </div>
                )}
              </div>

              {/* Swap button */}
              <Button
                variant="default"
                className="w-full mt-4 h-11 text-sm font-semibold rounded-xl"
                onClick={handleSwapClick}
                disabled={!canSwap || isSwapping || fromAmount <= 0 || isOverMax}
              >
                {isSwapping ? (
                  <span className="flex items-center gap-2">
                    <Spinner size={14} />
                    <span>{statusLabel}</span>
                  </span>
                ) : isOverMax ? (
                  'Insufficient balance'
                ) : (
                  'Swap'
                )}
              </Button>

              {/* Progress bar */}
              {isSwapping && (
                <div className="mt-3 space-y-2">
                  <div className="h-1 w-full bg-secondary rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-1000 ease-out ${progressColor}`}
                      style={{ width: progressWidth }}
                    />
                  </div>
                  {statusLabel && (
                    <p className={`text-xs text-center font-medium ${statusColor}`}>
                      {statusLabel}
                    </p>
                  )}
                </div>
              )}

              {/* Error */}
              {error && (
                <div className="mt-3 rounded-lg bg-destructive/10 border border-destructive/20 px-3 py-2">
                  <p className="text-xs text-destructive">{error}</p>
                </div>
              )}

              {/* Tx hash result */}
              {txHash && (
                <div className="mt-3 rounded-xl bg-secondary/50 border border-border/30 p-3">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-xs font-medium text-muted-foreground">Transaction</span>
                    <a
                      href={getExplorerUrl(txHash, network, 'transaction')}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 transition-colors"
                    >
                      Explorer
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                  <div className="flex items-center gap-2">
                    <code className="text-xs font-mono text-foreground/80 truncate flex-1">
                      {shortenAddress(txHash, 10)}
                    </code>
                    <CopyButton value={txHash} />
                  </div>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Confirmation dialog */}
      {showConfirmation && (
        <Dialog open={showConfirmation} onOpenChange={() => setShowConfirmation(false)}>
          <DialogContent className="sm:max-w-[380px] p-0 gap-0 border-border/50">
            <div className="px-5 pb-5 pt-10 space-y-4">
              <DialogHeader className="space-y-1">
                <DialogTitle className="text-base">Confirm Swap</DialogTitle>
                <DialogDescription className="text-xs">
                  Review your swap details before confirming
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-2">
                {/* From summary */}
                <div className="flex items-center justify-between rounded-xl bg-secondary/70 border border-border/30 p-3">
                  <div className="flex items-center gap-2.5">
                    <Image
                      src={TOKEN_ICONS[selectedFromToken.symbol] || adaIcon}
                      alt={selectedFromToken.symbol}
                      className="rounded-full"
                      width={28}
                      height={28}
                    />
                    <div>
                      <div className="text-xs text-muted-foreground">You pay</div>
                      <div className="text-sm font-semibold">{selectedFromToken.symbol}</div>
                    </div>
                  </div>
                  <span className="text-lg font-semibold tabular-nums">{fromAmount}</span>
                </div>

                {/* Arrow */}
                <div className="flex justify-center">
                  <div className="flex items-center justify-center h-6 w-6 rounded-md bg-secondary">
                    <ArrowDownUp className="h-3 w-3 text-muted-foreground" />
                  </div>
                </div>

                {/* To summary */}
                <div className="flex items-center justify-between rounded-xl bg-secondary/40 border border-border/20 p-3">
                  <div className="flex items-center gap-2.5">
                    <Image
                      src={TOKEN_ICONS[selectedToToken.symbol] || adaIcon}
                      alt={selectedToToken.symbol}
                      className="rounded-full"
                      width={28}
                      height={28}
                    />
                    <div>
                      <div className="text-xs text-muted-foreground">You receive</div>
                      <div className="text-sm font-semibold">{selectedToToken.symbol}</div>
                    </div>
                  </div>
                  <span className="text-lg font-semibold tabular-nums">~{toAmount.toFixed(4)}</span>
                </div>
              </div>

              {/* Details */}
              <div className="rounded-lg bg-muted/30 px-3 py-2 space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Rate</span>
                  <span>
                    1 {selectedFromToken.symbol} = {conversionRate.toFixed(5)}{' '}
                    {selectedToToken.symbol}
                  </span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Slippage</span>
                  <span>3%</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">DEX</span>
                  <span>SundaeSwap</span>
                </div>
              </div>

              {/* Action buttons */}
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  className="flex-1 h-10 rounded-xl"
                  onClick={() => setShowConfirmation(false)}
                >
                  Cancel
                </Button>
                <Button
                  className="flex-1 h-10 rounded-xl font-semibold"
                  onClick={handleConfirmSwap}
                >
                  Confirm Swap
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
