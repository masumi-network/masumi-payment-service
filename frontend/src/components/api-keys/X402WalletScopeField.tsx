import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { useX402Wallets } from '@/lib/hooks/useX402';
import { shortenAddress } from '@/lib/utils';

interface X402WalletScopeFieldProps {
  /** Whether this key is restricted to the selected managed EVM wallets. */
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  selectedIds: string[];
  onSelectedIdsChange: (ids: string[]) => void;
  /** Only fetch the wallet list while the surrounding dialog is open. */
  active: boolean;
}

/**
 * Assignable managed-EVM-wallet scope for an API key — the twin of the Cardano
 * hot-wallet scope picker it sits next to.
 *
 * Unchecked means unrestricted, matching the Cardano default rather than "no
 * wallets": a key with scoping off reaches every managed EVM wallet, and a scoped
 * key additionally always reaches the wallets it created itself.
 *
 * Shared by the add and update dialogs so the two cannot drift, and so neither
 * has to carry a second copy of the list markup.
 */
export function X402WalletScopeField({
  enabled,
  onEnabledChange,
  selectedIds,
  onSelectedIdsChange,
  active,
}: X402WalletScopeFieldProps) {
  // Read-level endpoint, so any signed-in session can populate the picker.
  const { wallets, isLoading } = useX402Wallets(active);

  return (
    <>
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Checkbox
            aria-label="Restrict to specific EVM wallets"
            checked={enabled}
            onCheckedChange={(checked) => {
              const next = checked === true;
              onEnabledChange(next);
              if (!next) {
                onSelectedIdsChange([]);
              }
            }}
          />
          <label className="text-sm font-medium">Restrict to specific EVM wallets</label>
        </div>
        <p className="text-xs text-muted-foreground">
          When enabled, this API key can only use the selected managed EVM wallets, plus any it
          creates itself. When disabled, it can use all of them.
        </p>
      </div>

      {enabled && (
        <div className="space-y-2">
          <label className="text-sm font-medium">EVM wallets in scope</label>
          <div className="border rounded-md max-h-48 overflow-y-auto">
            {isLoading ? (
              <p className="text-xs text-muted-foreground p-3">Loading wallets...</p>
            ) : wallets.length === 0 ? (
              <p className="text-xs text-muted-foreground p-3">No managed EVM wallets available</p>
            ) : (
              wallets.map((wallet) => (
                <label
                  key={wallet.id}
                  className="flex items-center gap-2 px-3 py-2 hover:bg-muted/50 cursor-pointer border-b last:border-b-0"
                >
                  <Checkbox
                    checked={selectedIds.includes(wallet.id)}
                    onCheckedChange={(checked) => {
                      if (checked) {
                        onSelectedIdsChange([...selectedIds, wallet.id]);
                      } else {
                        onSelectedIdsChange(selectedIds.filter((id) => id !== wallet.id));
                      }
                    }}
                  />
                  <span className="flex items-center gap-2 min-w-0">
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0 shrink-0">
                      {wallet.type}
                    </Badge>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {wallet.caip2Network}
                    </span>
                    <span className="font-mono text-xs truncate">
                      {shortenAddress(wallet.address)}
                    </span>
                    {wallet.note && (
                      <span className="text-xs text-muted-foreground truncate max-w-[120px]">
                        ({wallet.note})
                      </span>
                    )}
                  </span>
                </label>
              ))
            )}
          </div>
          {selectedIds.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {selectedIds.length} wallet{selectedIds.length !== 1 ? 's' : ''} selected
            </p>
          )}
        </div>
      )}
    </>
  );
}
