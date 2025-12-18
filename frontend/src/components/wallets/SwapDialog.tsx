/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable react-hooks/exhaustive-deps */

import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import swappableTokens from '@/assets/swappableTokens.json';
import { FaExchangeAlt } from 'react-icons/fa';
import { RefreshCw } from 'lucide-react';
import { getUtxos, getRpcApiKeys, postSwap } from '@/lib/api/generated';
import { useAppContext } from '@/lib/contexts/AppContext';
import { toast } from 'react-toastify';
import BlinkingUnderscore from '../BlinkingUnderscore';
import { shortenAddress, handleApiCall, getExplorerUrl } from '@/lib/utils';
import { Spinner } from '../ui/spinner';
import formatBalance from '@/lib/formatBalance';
import Image from 'next/image';
import { getUsdmConfig } from '@/lib/constants/defaultWallets';
import { CopyButton } from '@/components/ui/copy-button';
import { NMKR_CONFIG } from '@/lib/constants/defaultWallets';
import adaIcon from '@/assets/ada.png';
import usdmIcon from '@/assets/usdm.png';
import nmkrIcon from '@/assets/nmkr.png';
import { BlockfrostProvider } from '@meshsdk/core';

interface SwapDialogProps {
  isOpen: boolean;
  onClose: () => void;
  walletAddress: string;
  walletVkey: string;
  network: string;
}

export function SwapDialog({
  isOpen,
  onClose,
  walletAddress,
  walletVkey,
  network,
}: SwapDialogProps) {
  const { state, apiClient } = useAppContext();
  const [blockfrostApiKey, setBlockfrostApiKey] = useState<string>('');
  const [adaBalance, setAdaBalance] = useState<number>(0);
  const [usdmBalance, setUsdmBalance] = useState<number>(0);
  const [nmkrBalance, setNmkrBalance] = useState<number>(0);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [fromAmount, setFromAmount] = useState<number>(1);
  const [adaToUsdRate, setAdaToUsdRate] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(false);
  const [isFetchingDetails, setIsFetchingDetails] = useState<boolean>(true);
  const [isSwapping, setIsSwapping] = useState<boolean>(false);
  const [showConfirmation, setShowConfirmation] = useState<boolean>(false);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [blockfrostProvider, setBlockfrostProvider] =
    useState<BlockfrostProvider | null>(null);

  const adaIndex = swappableTokens.findIndex((token) => token.symbol === 'ADA');
  const usdmIndex = swappableTokens.findIndex(
    (token) => token.symbol === 'USDM',
  );

  const [selectedFromToken, setSelectedFromToken] = useState(
    swappableTokens[adaIndex],
  );
  const [selectedToToken, setSelectedToToken] = useState(
    swappableTokens[usdmIndex],
  );

  const [tokenRates, setTokenRates] = useState<Record<string, number>>({});

  const [swapStatus, setSwapStatus] = useState<
    'idle' | 'processing' | 'submitted' | 'confirmed'
  >('idle');

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
      // Clear states when dialog opens
      setTxHash(null);
      setError(null);
      setSwapStatus('idle');
      setIsSwapping(false);
      setShowConfirmation(false);
      fetchBlockfrostApiKey();
      fetchBalance();
      fetchTokenRates();

      const balanceInterval = setInterval(() => {
        fetchBalance();
      }, 20000);

      return () => clearInterval(balanceInterval);
    }
  }, [isOpen]);

  const initializeBlockfrostProvider = (apiKey: string) => {
    if (!apiKey) {
      setBlockfrostProvider(null);
      return;
    }
    try {
      const provider = new BlockfrostProvider(apiKey);
      setBlockfrostProvider(provider);
    } catch (error) {
      console.error('Error initializing Blockfrost provider:', error);
      setBlockfrostProvider(null);
    }
  };

  const fetchBlockfrostApiKey = async () => {
    try {
      const response = await getRpcApiKeys({
        client: apiClient,
      });

      if (response.error) {
        console.error('Failed to fetch RPC API keys:', response.error);
        setBlockfrostApiKey('');
        setBlockfrostProvider(null);
        return;
      }

      const mainnetKey = (response.data as any)?.data?.RpcProviderKeys?.find(
        (key: any) =>
          key.network === 'Mainnet' && key.rpcProvider === 'Blockfrost',
      );
      const apiKey = mainnetKey?.rpcProviderApiKey || '';
      setBlockfrostApiKey(apiKey);

      // Initialize provider using the function
      initializeBlockfrostProvider(apiKey);
    } catch (error) {
      console.error('Error fetching Blockfrost API key:', error);
      setBlockfrostApiKey('');
      setBlockfrostProvider(null);
    }
  };

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
          network: state.network,
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
      const usdmConfig = getUsdmConfig(state.network);
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
      const nmkr =
        result?.data?.data?.Utxos?.reduce((acc, utxo) => {
          return (
            acc +
            utxo.Amounts.reduce((acc, asset) => {
              if (asset.unit === NMKR_CONFIG?.fullAssetId) {
                return acc + (asset.quantity ?? 0);
              }
              return acc;
            }, 0)
          );
        }, 0) ?? 0;

      setAdaBalance(lovelace / 1000000);
      setUsdmBalance(usdm / 1000000);
      setNmkrBalance(nmkr / 1000000);
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
    network?.toLowerCase() === 'mainnet' &&
    walletVkey !== null;

  const handleSwitch = () => {
    if (
      selectedFromToken.symbol === 'ADA' ||
      selectedToToken.symbol === 'ADA'
    ) {
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
      if (
        selectedToken.symbol !== 'ADA' &&
        selectedFromToken.symbol !== 'ADA'
      ) {
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
      case 'NMKR':
        return nmkrBalance;
      default:
        return 0;
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
    if (
      selectedFromToken.symbol === 'ADA' &&
      selectedToToken.symbol === 'USDM'
    ) {
      return adaToUsdRate;
    } else if (
      selectedFromToken.symbol === 'USDM' &&
      selectedToToken.symbol === 'ADA'
    ) {
      return 1 / adaToUsdRate;
    } else if (selectedFromToken.symbol === 'ADA') {
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

  const formattedDollarValue =
    selectedFromToken.symbol === 'USDM'
      ? `~$${fromAmount.toFixed(2)}`
      : `$${toAmount.toFixed(2)}`;

  const formattedFromBalance = formatBalance(
    getBalanceForToken(selectedFromToken.symbol).toFixed(6),
  );
  const formattedFromMax = formatBalance(
    getMaxAmount(selectedFromToken.symbol).toFixed(2),
  );
  const formattedToBalance = formatBalance(
    getBalanceForToken(selectedToToken.symbol).toFixed(6),
  );

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

      if (!state?.apiKey) {
        throw new Error('API key not found');
      }

      if (!blockfrostApiKey) {
        throw new Error(
          'Blockfrost API key not found in selected payment source',
        );
      }

      const isFromAda = selectedFromToken.symbol === 'ADA';
      const poolId = selectedFromToken.poolId || selectedToToken.poolId || '';

      if (!poolId) {
        throw new Error('Pool ID not found for selected tokens');
      }

      const fromToken = {
        policyId:
          selectedFromToken.policyId === 'NATIVE' ||
          selectedFromToken.policyId === ''
            ? ''
            : selectedFromToken.policyId || '',
        assetName:
          selectedFromToken.assetName === 'ADA' ||
          selectedFromToken.assetName === 'NATIVE'
            ? ''
            : selectedFromToken.assetName || '',
        name: selectedFromToken.name || selectedFromToken.symbol,
      };

      const toToken = {
        policyId:
          selectedToToken.policyId === 'NATIVE' ||
          selectedToToken.policyId === ''
            ? ''
            : selectedToToken.policyId || '',
        assetName:
          selectedToToken.assetName === 'ADA' ||
          selectedToToken.assetName === 'NATIVE'
            ? ''
            : selectedToToken.assetName || '',
        name: selectedToToken.name || selectedToToken.symbol,
      };

      const response = await handleApiCall(
        () =>
          postSwap({
            client: apiClient,
            body: {
              walletVkey,
              amount: fromAmount,
              isFromAda,
              fromToken,
              toToken,
              poolId,
              blockfrostApiKey,
              slippage: 0.03,
            },
          }),
        {
          onSuccess: (result) => {
            // The API response structure: result.data.data.txHash (consistent with other API calls)
            // Check both possible paths in case the structure differs
            const transactionHash =
              (result as any)?.data?.data?.txHash ||
              (result as any)?.data?.txHash;

            if (transactionHash) {
              setTxHash(transactionHash);
            }

            setSwapStatus('submitted');
            toast.info('Swap transaction submitted!', { theme: 'dark' });

            if (transactionHash && blockfrostProvider) {
              blockfrostProvider.onTxConfirmed(transactionHash, () => {
                fetchBalance();
                setSwapStatus('confirmed');
                toast.success('Swap completed successfully!', {
                  theme: 'dark',
                });
                setIsSwapping(false);
                setTimeout(() => setSwapStatus('idle'), 2000);
              });
            } else {
              if (!transactionHash) {
                console.error(
                  'Transaction hash not found in response:',
                  result,
                );
              }
              if (!blockfrostProvider) {
                console.warn(
                  'Blockfrost provider not available, using timeout fallback',
                );
              }
              setTimeout(async () => {
                await fetchBalance();
                setSwapStatus('confirmed');
                toast.success('Swap completed successfully!', {
                  theme: 'dark',
                });
                setIsSwapping(false);
                setTimeout(() => setSwapStatus('idle'), 2000);
              }, 3000);
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
      console.error('Swap error:', error);
      const errorMessage = error?.message || 'Swap failed';
      toast.error(`Swap failed: ${errorMessage}`, { theme: 'dark' });
      setError(errorMessage);
      setIsSwapping(false);
      setSwapStatus('idle');
    }
  };

  const getProgressBarColor = () => {
    switch (swapStatus) {
      case 'processing':
        return 'bg-orange-500';
      case 'submitted':
        return 'bg-blue-500';
      case 'confirmed':
        return 'bg-green-500';
      default:
        return 'bg-transparent';
    }
  };

  const getTokenIcon = (symbol: string) => {
    switch (symbol) {
      case 'ADA':
        return adaIcon;
      case 'USDM':
        return usdmIcon;
      case 'NMKR':
        return nmkrIcon;
      default:
        return adaIcon;
    }
  };

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
        <DialogContent className="overflow-y-hidden">
          <DialogHeader>
            <div className="flex items-end justify-between">
              <div className="flex flex-col space-y-2">
                <DialogTitle>Swap Tokens</DialogTitle>
                <DialogDescription>
                  {network?.toLowerCase() === 'preprod' ? 'PREPROD' : 'MAINNET'}{' '}
                  Network
                  <br />
                  <i>{shortenAddress(walletAddress, 6)}</i>
                </DialogDescription>
              </div>
              <Button
                size="icon"
                variant="outline"
                className="h-8 w-8"
                onClick={() => {
                  setIsFetchingDetails(true);
                  fetchBalance();
                }}
                disabled={isFetchingDetails || isSwapping}
                title="Refresh Balance"
              >
                <RefreshCw
                  className={isFetchingDetails ? 'animate-spin' : ''}
                />
              </Button>
            </div>
          </DialogHeader>
          {isFetchingDetails ? (
            <div className="text-center text-gray-500 mb-4">
              <BlinkingUnderscore />
            </div>
          ) : (
            <>
              {network?.toLowerCase() !== 'mainnet' && (
                <div className="text-red-500 mb-4">
                  Swap is only available on <b>MAINNET</b> network
                </div>
              )}
              {network?.toLowerCase() === 'mainnet' && (
                <div>
                  <div className="flex flex-col space-y-4">
                    <div
                      className={`flex flex-col space-y-4 transition-opacity duration-300 ${isSwapping ? 'opacity-50 pointer-events-none' : 'opacity-100'}`}
                    >
                      <div className="flex justify-between items-center bg-secondary p-4 rounded-md">
                        <div className="flex flex-col space-y-1">
                          <div className="flex items-center space-x-2">
                            <select
                              value={swappableTokens.indexOf(selectedFromToken)}
                              onChange={(e) =>
                                handleTokenChange(
                                  'from',
                                  parseInt(e.target.value),
                                )
                              }
                              className="bg-transparent text-foreground"
                            >
                              {swappableTokens.map((token, index) => (
                                <option key={token.symbol} value={index}>
                                  {token.symbol}
                                </option>
                              ))}
                            </select>
                            <Image
                              src={getTokenIcon(selectedFromToken.symbol)}
                              alt="Token"
                              className="w-6 h-6 rounded-full"
                              width={24}
                              height={24}
                            />
                          </div>
                          <div className="text-xs text-muted-foreground">
                            Balance: {formattedFromBalance}
                          </div>
                        </div>
                        <div className="flex flex-col items-end">
                          <div className="relative w-full">
                            <input
                              type="number"
                              className={`w-24 text-right bg-transparent border-b border-muted-foreground/50 focus:outline-none appearance-none text-[24px] font-bold mb-2 text-foreground ${
                                fromAmount >
                                getMaxAmount(selectedFromToken.symbol)
                                  ? 'text-red-500'
                                  : ''
                              }`}
                              placeholder="0"
                              value={fromAmount || ''}
                              onChange={handleFromAmountChange}
                              step="0.2"
                              style={{ MozAppearance: 'textfield' }}
                            />
                            <span
                              className="absolute right-0 -top-3 text-xs text-muted-foreground cursor-pointer hover:text-foreground"
                              onClick={handleMaxClick}
                            >
                              Max: {formattedFromMax}
                            </span>
                          </div>
                          <span className="block text-xs text-muted-foreground">
                            {formattedDollarValue}
                          </span>
                        </div>
                      </div>
                      <div className="relative flex items-center">
                        <div className="flex-grow border-t border-border"></div>
                        <Button
                          onClick={handleSwitch}
                          className="mx-4 p-2 w-10 h-10 flex items-center justify-center transform rotate-90"
                        >
                          <FaExchangeAlt className="w-5 h-5" />
                        </Button>
                        <div className="flex-grow border-t border-border"></div>
                      </div>
                      <div className="flex justify-between items-center bg-secondary p-4 rounded-md">
                        <div className="flex flex-col space-y-1">
                          <div className="flex items-center space-x-2">
                            <select
                              value={swappableTokens.indexOf(selectedToToken)}
                              onChange={(e) =>
                                handleTokenChange(
                                  'to',
                                  parseInt(e.target.value),
                                )
                              }
                              className="bg-transparent text-foreground"
                            >
                              {swappableTokens.map((token, index) => (
                                <option key={token.symbol} value={index}>
                                  {token.symbol}
                                </option>
                              ))}
                            </select>
                            <Image
                              src={getTokenIcon(selectedToToken.symbol)}
                              alt="Token"
                              className="w-6 h-6 rounded-full"
                              width={24}
                              height={24}
                            />
                          </div>
                          <div className="text-xs text-muted-foreground">
                            Balance: {formattedToBalance}
                          </div>
                        </div>
                        <div className="flex flex-col items-end">
                          <input
                            type="text"
                            className="w-24 text-right bg-transparent focus:outline-none appearance-none text-foreground"
                            placeholder="0"
                            value={toAmount.toFixed(6)}
                            readOnly
                          />
                        </div>
                      </div>
                    </div>
                    <div className="text-center text-sm text-muted-foreground">
                      1 {selectedFromToken.symbol} ≈ {conversionRate.toFixed(5)}{' '}
                      {selectedToToken.symbol}
                    </div>
                    <Button
                      variant="default"
                      className="w-full"
                      onClick={handleSwapClick}
                      disabled={
                        !canSwap ||
                        isSwapping ||
                        fromAmount <= 0 ||
                        fromAmount > getMaxAmount(selectedFromToken.symbol)
                      }
                    >
                      {isSwapping
                        ? swapStatus === 'submitted' ||
                          swapStatus === 'confirmed'
                          ? 'Confirming'
                          : 'Swap in Progress...'
                        : 'Swap'}{' '}
                      {isSwapping && <Spinner size={16} className="ml-1" />}
                    </Button>
                    {error && <div className="text-red-500 mt-2">{error}</div>}
                    {txHash && (
                      <div className="mt-4 p-3 bg-muted/30 rounded-md border border-border/50">
                        <div className="text-sm font-medium mb-2">
                          Transaction Hash
                        </div>
                        <div className="flex items-center gap-2">
                          <a
                            href={getExplorerUrl(
                              txHash,
                              state.network,
                              'transaction',
                            )}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-sm font-mono break-all hover:underline text-primary flex-1 bg-muted/30 rounded-md p-2 truncate"
                          >
                            {txHash ? shortenAddress(txHash, 8) : '—'}
                          </a>
                          <CopyButton value={txHash} />
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
              {network?.toLowerCase() === 'mainnet' && (
                <div>
                  <div className="flex flex-col space-y-4">
                    <div
                      className={`flex flex-col space-y-4 transition-opacity duration-300 ${isSwapping ? 'opacity-50 pointer-events-none' : 'opacity-100'}`}
                    >
                      <div className="flex justify-between items-center bg-secondary p-4 rounded-md">
                        <div className="flex flex-col space-y-1">
                          <div className="flex items-center space-x-2">
                            <select
                              value={swappableTokens.indexOf(selectedFromToken)}
                              onChange={(e) =>
                                handleTokenChange(
                                  'from',
                                  parseInt(e.target.value),
                                )
                              }
                              className="bg-transparent text-foreground"
                            >
                              {swappableTokens.map((token, index) => (
                                <option key={token.symbol} value={index}>
                                  {token.symbol}
                                </option>
                              ))}
                            </select>
                            <Image
                              src={getTokenIcon(selectedFromToken.symbol)}
                              alt="Token"
                              className="w-6 h-6 rounded-full"
                              width={24}
                              height={24}
                            />
                          </div>
                          <div className="text-xs text-muted-foreground">
                            Balance: {formattedFromBalance}
                          </div>
                        </div>
                        <div className="flex flex-col items-end">
                          <div className="relative w-full">
                            <input
                              type="number"
                              className={`w-24 text-right bg-transparent border-b border-muted-foreground/50 focus:outline-none appearance-none text-[24px] font-bold mb-2 text-foreground ${
                                fromAmount >
                                getMaxAmount(selectedFromToken.symbol)
                                  ? 'text-red-500'
                                  : ''
                              }`}
                              placeholder="0"
                              value={fromAmount || ''}
                              onChange={handleFromAmountChange}
                              step="0.2"
                              style={{ MozAppearance: 'textfield' }}
                            />
                            <span
                              className="absolute right-0 -top-3 text-xs text-muted-foreground cursor-pointer hover:text-foreground"
                              onClick={handleMaxClick}
                            >
                              Max: {formattedFromMax}
                            </span>
                          </div>
                          <span className="block text-xs text-muted-foreground">
                            {formattedDollarValue}
                          </span>
                        </div>
                      </div>
                      <div className="relative flex items-center">
                        <div className="flex-grow border-t border-border"></div>
                        <Button
                          onClick={handleSwitch}
                          className="mx-4 p-2 w-10 h-10 flex items-center justify-center transform rotate-90"
                        >
                          <FaExchangeAlt className="w-5 h-5" />
                        </Button>
                        <div className="flex-grow border-t border-border"></div>
                      </div>
                      <div className="flex justify-between items-center bg-secondary p-4 rounded-md">
                        <div className="flex flex-col space-y-1">
                          <div className="flex items-center space-x-2">
                            <select
                              value={swappableTokens.indexOf(selectedToToken)}
                              onChange={(e) =>
                                handleTokenChange(
                                  'to',
                                  parseInt(e.target.value),
                                )
                              }
                              className="bg-transparent text-foreground"
                            >
                              {swappableTokens.map((token, index) => (
                                <option key={token.symbol} value={index}>
                                  {token.symbol}
                                </option>
                              ))}
                            </select>
                            <Image
                              src={getTokenIcon(selectedToToken.symbol)}
                              alt="Token"
                              className="w-6 h-6 rounded-full"
                              width={24}
                              height={24}
                            />
                          </div>
                          <div className="text-xs text-muted-foreground">
                            Balance: {formattedToBalance}
                          </div>
                        </div>
                        <div className="flex flex-col items-end">
                          <input
                            type="text"
                            className="w-24 text-right bg-transparent focus:outline-none appearance-none text-foreground"
                            placeholder="0"
                            value={toAmount.toFixed(6)}
                            readOnly
                          />
                        </div>
                      </div>
                    </div>
                    <div className="text-center text-sm text-muted-foreground">
                      1 {selectedFromToken.symbol} ≈ {conversionRate.toFixed(5)}{' '}
                      {selectedToToken.symbol}
                    </div>
                    <Button
                      variant="default"
                      className="w-full"
                      onClick={handleSwapClick}
                      disabled={
                        !canSwap ||
                        isSwapping ||
                        fromAmount <= 0 ||
                        fromAmount > getMaxAmount(selectedFromToken.symbol)
                      }
                    >
                      {isSwapping
                        ? swapStatus === 'submitted' ||
                          swapStatus === 'confirmed'
                          ? 'Confirming'
                          : 'Swap in Progress...'
                        : 'Swap'}{' '}
                      {isSwapping && <Spinner size={16} className="ml-1" />}
                    </Button>
                    {error && <div className="text-red-500 mt-2">{error}</div>}
                    {txHash && (
                      <div className="mt-4 p-3 bg-muted/30 rounded-md border border-border/50">
                        <div className="text-sm font-medium mb-2">
                          Transaction Hash
                        </div>
                        <div className="flex items-center gap-2">
                          <a
                            href={getExplorerUrl(
                              txHash,
                              state.network,
                              'transaction',
                            )}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-sm font-mono break-all hover:underline text-primary flex-1 bg-muted/30 rounded-md p-2 truncate"
                          >
                            {txHash ? shortenAddress(txHash, 8) : '—'}
                          </a>
                          <CopyButton value={txHash} />
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
              {isSwapping && (
                <div className="w-full h-[4px] bg-gray-700 rounded-full overflow-hidden animate-bounce-bottom">
                  <div
                    className={`h-full transition-all duration-1000 ease-in-out ${getProgressBarColor()}`}
                    style={{
                      width:
                        swapStatus === 'processing'
                          ? '20%'
                          : swapStatus === 'submitted'
                            ? '66%'
                            : swapStatus === 'confirmed'
                              ? '100%'
                              : '0%',
                    }}
                  />
                </div>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
      {showConfirmation && (
        <Dialog
          open={showConfirmation}
          onOpenChange={() => setShowConfirmation(false)}
        >
          <DialogContent className="sm:max-w-[425px]">
            <DialogHeader>
              <DialogTitle>Confirm Swap</DialogTitle>
              <DialogDescription>
                Are you sure you want to swap:
              </DialogDescription>
              <div className="mt-2 font-medium">
                {fromAmount} {selectedFromToken.symbol} → {toAmount.toFixed(6)}{' '}
                {selectedToToken.symbol}
              </div>
            </DialogHeader>
            <div className="flex justify-end space-x-2 mt-4">
              <Button
                variant="outline"
                onClick={() => setShowConfirmation(false)}
              >
                Cancel
              </Button>
              <Button onClick={handleConfirmSwap}>Confirm Swap</Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
