import { useEffect } from 'react';
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
  // Extensions inject `window.cardano` after load, so look once the panel shows.
  useEffect(onDetect, [onDetect]);

  if (connectedName != null) {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Owner wallet</span>
          <span>{connectedName}</span>
          <Button variant="ghost" size="sm" className="h-7" onClick={onDisconnect}>
            Disconnect
          </Button>
        </div>
        {problem && <div className="text-xs text-destructive">{problem}</div>}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="text-xs text-muted-foreground">
        Connect the browser wallet that holds the owner key. It signs each move; the key never
        leaves the extension.
      </div>
      {options.length === 0 ? (
        <div className="flex items-center gap-2 text-sm">
          No CIP-30 wallet found in this browser.
          <Button variant="ghost" size="sm" className="h-7" onClick={onDetect}>
            Look again
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {options.map((option) => (
            <Button
              key={option.id}
              variant="outline"
              size="sm"
              className="h-8"
              disabled={isConnecting}
              onClick={() => onConnect(option.id)}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- extension data URI */}
              <img src={option.icon} alt="" className="h-4 w-4" />
              {option.name}
            </Button>
          ))}
          {isConnecting && <Spinner size={16} />}
        </div>
      )}
      {error && <div className="text-xs text-destructive">{error}</div>}
    </div>
  );
}
