import { useCallback, useEffect, useState } from 'react';
import { BrowserWallet } from '@meshsdk/core';
import { extractApiErrorMessage } from '@/lib/api-error';
import { CIP30_NETWORK_ID, walletHoldsOwnerKey } from './owner-key';

/**
 * Extensions inject `window.cardano` some time after page load, and a locked
 * wallet may only appear once it is unlocked. Look a few times early on.
 */
const DETECT_RETRY_MS = [500, 1500, 3000];

/** A browser extension that exposes CIP-30 under `window.cardano`. */
export type Cip30WalletOption = { id: string; name: string; icon: string };

type Cip30Connection = {
  id: string;
  name: string;
  wallet: BrowserWallet;
  networkId: number;
  addresses: string[];
};

/**
 * A CIP-30 browser wallet (Eternl, Lace, Nami, ...) that signs for the owner.
 *
 * The owner key stays in the extension: this hook only asks it for addresses
 * and for a partial signature over a transaction the service prepared.
 */
export function useCip30Wallet() {
  const [options, setOptions] = useState<Cip30WalletOption[]>([]);
  const [connection, setConnection] = useState<Cip30Connection | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Reads `window.cardano`, so call it from an effect or an event, never during render. */
  const detect = useCallback(() => {
    setOptions(
      BrowserWallet.getInstalledWallets().map(({ id, name, icon }) => ({ id, name, icon })),
    );
  }, []);

  // Look now, a few times while extensions load, and whenever the tab regains
  // focus (the operator may have installed or unlocked a wallet meanwhile).
  useEffect(() => {
    detect();
    const timers = DETECT_RETRY_MS.map((ms) => window.setTimeout(detect, ms));
    window.addEventListener('focus', detect);
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      window.removeEventListener('focus', detect);
    };
  }, [detect]);

  const connect = async (id: string) => {
    setIsConnecting(true);
    setError(null);
    try {
      const wallet = await BrowserWallet.enable(id);
      const [networkId, used, unused, change] = await Promise.all([
        wallet.getNetworkId(),
        wallet.getUsedAddresses(),
        wallet.getUnusedAddresses(),
        wallet.getChangeAddress(),
      ]);
      const name = options.find((option) => option.id === id)?.name ?? id;
      setConnection({ id, name, wallet, networkId, addresses: [...used, ...unused, change] });
    } catch (cause) {
      setConnection(null);
      setError(extractApiErrorMessage(cause, 'The wallet refused the connection'));
    } finally {
      setIsConnecting(false);
    }
  };

  const disconnect = () => {
    setConnection(null);
    setError(null);
  };

  /** Why this wallet cannot sign for `ownerAddress` on `network`, or null when it can. */
  const signingProblem = (network: 'Preprod' | 'Mainnet', ownerAddress: string): string | null => {
    if (connection == null) return 'Connect the owner wallet above to sign this move';
    if (connection.networkId !== CIP30_NETWORK_ID[network]) {
      return `${connection.name} is on the wrong network. Switch it to ${network}`;
    }
    if (!walletHoldsOwnerKey(connection.addresses, ownerAddress)) {
      return `${connection.name} does not hold the owner key of this wallet`;
    }
    return null;
  };

  /** Owner witness added to the prepared transaction; the body bytes stay as they are. */
  const signPartial = async (unsignedTx: string): Promise<string> => {
    if (connection == null) throw new Error('Connect the owner wallet first');
    return connection.wallet.signTx(unsignedTx, true);
  };

  return {
    options,
    detect,
    connection: connection == null ? null : { id: connection.id, name: connection.name },
    isConnecting,
    error,
    connect,
    disconnect,
    signingProblem,
    signPartial,
  };
}
