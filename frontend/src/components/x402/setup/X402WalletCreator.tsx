import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useCreateX402Wallet } from '@/lib/hooks/useCreateX402Wallet';
import type { X402WalletCreated } from '@/lib/api/generated';
import {
  parseImportedPrivateKey,
  type X402WalletKeySource,
  type X402WalletType,
} from '@/lib/x402-wallet-key';
import { WalletKeySourceField } from '@/components/x402/wallet-setup/WalletKeySourceField';
import { WalletKeyBackupPanel } from '@/components/x402/wallet-setup/WalletKeyBackupPanel';

/**
 * Inline wallet creation for the setup wizard. The chain and direction come from the step,
 * so the operator only chooses how the key is made. A generated key goes through the
 * one-time backup before `onReady` fires; an imported key is ready at once.
 */
export function X402WalletCreator({
  chainId,
  type,
  createLabel,
  readyLabel,
  isFinishing = false,
  onBackupPendingChange,
  onReady,
}: {
  chainId: string;
  type: X402WalletType;
  createLabel: string;
  /** Label of the backup confirmation button, which also triggers `onReady`. */
  readyLabel: string;
  isFinishing?: boolean;
  /**
   * True while the one-time key is on screen. The parent must keep this component mounted
   * until it turns false, even if a wallet-list refetch would otherwise hide it, or the only
   * copy of the key is lost.
   */
  onBackupPendingChange?: (isPending: boolean) => void;
  onReady: (wallet: X402WalletCreated) => void;
}) {
  const { createWallet, isCreating } = useCreateX402Wallet();
  const [keySource, setKeySource] = useState<X402WalletKeySource>('generate');
  const [privateKey, setPrivateKey] = useState('');
  const [keyError, setKeyError] = useState<string | null>(null);
  const [pendingBackup, setPendingBackup] = useState<X402WalletCreated | null>(null);

  if (pendingBackup?.privateKey) {
    return (
      <div className="space-y-3">
        <div>
          <p className="text-sm font-medium">Back up the private key</p>
          <p className="text-pretty text-xs text-muted-foreground">
            This is the only time the key is shown. You need it to recover the wallet.
          </p>
        </div>
        <WalletKeyBackupPanel
          type={type}
          address={pendingBackup.address}
          privateKey={pendingBackup.privateKey}
          confirmLabel={readyLabel}
          isConfirming={isFinishing}
          onConfirmed={() => {
            onBackupPendingChange?.(false);
            onReady(pendingBackup);
          }}
        />
      </div>
    );
  }

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    let importedKey: string | undefined;
    if (keySource === 'import') {
      const parsed = parseImportedPrivateKey(privateKey);
      if (!parsed.ok) {
        setKeyError(parsed.error);
        return;
      }
      importedKey = parsed.privateKey;
    }
    setKeyError(null);
    const created = await createWallet({
      networkId: chainId,
      type,
      keySource,
      privateKey: importedKey,
    });
    if (!created) return;
    if (keySource === 'generate' && created.privateKey) {
      setPendingBackup(created);
      onBackupPendingChange?.(true);
      return;
    }
    onReady(created);
  };

  return (
    <form onSubmit={create} className="space-y-4">
      <WalletKeySourceField
        keySource={keySource}
        onKeySourceChange={(value) => {
          setKeySource(value);
          setKeyError(null);
        }}
        privateKey={privateKey}
        onPrivateKeyChange={setPrivateKey}
        error={keyError}
      />
      <Button type="submit" disabled={isCreating || isFinishing} className="w-full gap-2">
        <Plus className="size-4" aria-hidden />
        {isCreating ? 'Creating…' : createLabel}
      </Button>
    </form>
  );
}
