import { useState } from 'react';
import { useAppContext } from '@/lib/contexts/AppContext';
import { hexToAscii } from '@/lib/utils';
import formatBalance from '@/lib/formatBalance';
import { convertBaseUnitsToDecimal } from '@/lib/convertDecimalToBaseUnits';
import { useRate } from '@/lib/hooks/useRate';
import { fetchAddressBalance } from '@/lib/wallet-balance';
import { getUsdmConfig, USDCX_CONFIG } from '@/lib/constants/defaultWallets';
import {
  CARDANO_POLICY_ID_HEX_LENGTH,
  type TokenBalance,
  type WalletWithBalance,
} from '@/components/wallets/wallet-details-utils';

/**
 * Owns the wallet token-balance fetch + formatting. Extracted verbatim from
 * WalletDetailsDialog: the parent assigns `fetchTokenBalances` into its refresh
 * ref so swap-polling callbacks keep triggering a balance refresh unchanged.
 */
export function useTokenBalances(wallet: WalletWithBalance | null) {
  const { apiClient, network } = useAppContext();
  const [isLoading, setIsLoading] = useState(true);
  const [tokenBalances, setTokenBalances] = useState<TokenBalance[]>([]);
  const [error, setError] = useState<string | null>(null);
  const { rate } = useRate();

  const usdmConfig = getUsdmConfig(network);

  const isUSDCx = (token: TokenBalance) =>
    token.policyId === USDCX_CONFIG.policyId &&
    token.assetName === hexToAscii(USDCX_CONFIG.assetName);

  const isUSDM = (token: TokenBalance) =>
    token.policyId === usdmConfig.policyId && token.assetName === hexToAscii(usdmConfig.assetName);

  const formatTokenBalance = (token: TokenBalance) => {
    // Decimal string is derived BigInt-safely (no 2^53 precision loss). USD
    // values are only an approximate `≈` figure, so Number() there is fine.
    const toDecimal = () => convertBaseUnitsToDecimal(token.quantity.toString(), 6);
    const approxUnits = Number(token.quantity) / 1_000_000;

    if (token.unit === 'lovelace') {
      return {
        amount: token.quantity === BigInt(0) ? 'zero' : formatBalance(toDecimal()),
        usdValue: rate ? `≈ $${(approxUnits * rate).toFixed(2)}` : undefined,
      };
    }

    if (isUSDCx(token)) {
      return {
        amount: token.quantity === BigInt(0) ? 'zero' : formatBalance(toDecimal()),
        usdValue: `≈ $${approxUnits.toFixed(2)}`,
      };
    }

    if (isUSDM(token)) {
      return {
        amount: token.quantity === BigInt(0) ? 'zero' : formatBalance(toDecimal()),
        usdValue: `≈ $${approxUnits.toFixed(2)}`,
      };
    }

    // Unknown tokens: display raw quantity (no decimal conversion)
    return {
      amount: token.quantity === BigInt(0) ? 'zero' : formatBalance(token.quantity.toString()),
      usdValue: undefined,
    };
  };

  const fetchTokenBalances = async () => {
    if (!wallet) return;

    setIsLoading(true);
    setError(null);
    setTokenBalances([]); // Reset balances when refreshing

    try {
      const balance = await fetchAddressBalance(apiClient, network, wallet.walletAddress);
      const balanceMap = new Map<string, bigint>();

      balance.forEach((amount) => {
        const unit = amount.unit === '' ? 'lovelace' : amount.unit;
        const currentAmount = balanceMap.get(unit) || BigInt(0);
        balanceMap.set(unit, currentAmount + BigInt(amount.quantity || 0));
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
    } catch {
      setTokenBalances([]);
      setError('Failed to fetch token balances');
    } finally {
      setIsLoading(false);
    }
  };

  return {
    tokenBalances,
    isLoading,
    error,
    fetchTokenBalances,
    formatTokenBalance,
    isUSDCx,
    isUSDM,
  };
}
