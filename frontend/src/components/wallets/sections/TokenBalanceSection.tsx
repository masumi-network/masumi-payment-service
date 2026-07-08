import { Spinner } from '@/components/ui/spinner';
import { shortenAddress, getExplorerUrl } from '@/lib/utils';
import {
  CARDANO_POLICY_ID_HEX_LENGTH,
  type TokenBalance,
} from '@/components/wallets/wallet-details-utils';

export function TokenBalanceSection({
  isLoading,
  error,
  tokenBalances,
  network,
  formatTokenBalance,
  isUSDCx,
  isUSDM,
}: {
  isLoading: boolean;
  error: string | null;
  tokenBalances: TokenBalance[];
  network: 'Preprod' | 'Mainnet';
  formatTokenBalance: (token: TokenBalance) => { amount: string; usdValue?: string };
  isUSDCx: (token: TokenBalance) => boolean;
  isUSDM: (token: TokenBalance) => boolean;
}) {
  return (
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
                    {usdValue && <div className="text-xs text-muted-foreground">{usdValue}</div>}
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
  );
}
