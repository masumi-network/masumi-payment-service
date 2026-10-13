import { AlertTriangle, Wallet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import type { Cip30WalletOption } from '@/lib/cip30/useCip30Wallet';

/**
 * Picks the CIP-30 browser wallet that holds the owner key. Renders and
 * forwards only; useCip30Wallet owns the connection.
 */
export function OwnerWalletConnect({
  options,
  connectedName,
  isConnecting,
  error,
  problem,
  onDetect,
  onConnect,
  onDisconnect,
}: {
  options: Cip30WalletOption[];
  connectedName: string | null;
  isConnecting: boolean;
  error: string | null;
  /** Why the connected wallet cannot sign, e.g. wrong network or not the owner. */
  problem: string | null;
  onDetect: () => void;
  onConnect: (id: string) => void;
  onDisconnect: () => void;
}) {
  if (connectedName != null) {
    return (
      <div className="flex flex-col gap-2 rounded-md bg-muted/50 px-3 py-2">
        <div className="flex items-center justify-between gap-2 text-sm">
          <span className="flex items-center gap-2">
            <span
              className={`h-2 w-2 rounded-full ${problem ? 'bg-amber-500' : 'bg-green-500'}`}
              aria-hidden
            />
            Signing with <span className="font-medium">{connectedName}</span>
          </span>
          <Button variant="ghost" size="sm" className="h-7" onClick={onDisconnect}>
            Disconnect
          </Button>
        </div>
        {problem && (
          <div className="flex items-start gap-2 text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {problem}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-dashed px-3 py-3">
      <div className="flex items-start gap-2">
        <Wallet className="mt-0.5 h-4 w-4 text-muted-foreground" />
        <div className="text-sm">
          <div className="font-medium">Connect the owner wallet</div>
          <div className="text-xs text-muted-foreground">
            Each move needs one signature from the owner key. The key stays in your browser wallet.
            Unlock the wallet first if it does not show up here.
          </div>
        </div>
      </div>
      {options.length === 0 ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          No Cardano browser wallet found. Install Eternl or Lace, then
          <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={onDetect}>
            look again
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {options.map((option) => (
            <Button
              key={option.id}
              size="sm"
              className="h-8"
              disabled={isConnecting}
              onClick={() => onConnect(option.id)}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- extension data URI */}
              <img src={option.icon} alt="" className="h-4 w-4" />
              Connect {option.name}
            </Button>
          ))}
          {isConnecting && <Spinner size={16} />}
        </div>
      )}
      {error && <div className="text-xs text-destructive">{error}</div>}
    </div>
  );
}
