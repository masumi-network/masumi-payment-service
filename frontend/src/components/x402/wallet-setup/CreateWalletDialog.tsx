import { useId, useState } from 'react';
import { toast } from 'react-toastify';
import { KeyRound, ShoppingCart, Store } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useX402Networks } from '@/lib/hooks/useX402';
import { useCreateX402Wallet } from '@/lib/hooks/useCreateX402Wallet';
import { cn } from '@/lib/utils';
import {
  parseImportedPrivateKey,
  type X402WalletKeySource,
  type X402WalletType,
} from '@/lib/x402-wallet-key';
import { WalletKeyBackupPanel } from '@/components/x402/wallet-setup/WalletKeyBackupPanel';
import { WalletKeySourceField } from '@/components/x402/wallet-setup/WalletKeySourceField';

const WALLET_TYPE_OPTIONS: Array<{
  value: X402WalletType;
  label: string;
  hint: string;
  icon: typeof ShoppingCart;
}> = [
  {
    value: 'Purchasing',
    label: 'Purchasing',
    hint: 'Pays other agents for x402 resources.',
    icon: ShoppingCart,
  },
  {
    value: 'Selling',
    label: 'Selling',
    hint: 'Settles payments your agents receive and pays the gas.',
    icon: Store,
  },
];

/**
 * Creates a managed x402 wallet bound to one chain. When the caller already knows the chain
 * or the direction (for example the setup guide), pass `isNetworkLocked` / `isTypeLocked` so
 * the dialog shows that context instead of asking again.
 */
export function CreateWalletDialog({
  open,
  onClose,
  onSaved,
  defaultType = 'Purchasing',
  defaultNetworkId,
  isNetworkLocked = false,
  isTypeLocked = false,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  defaultType?: X402WalletType;
  defaultNetworkId?: string;
  isNetworkLocked?: boolean;
  isTypeLocked?: boolean;
}) {
  const { networks, isLoading: networksLoading } = useX402Networks();
  const { createWallet, isCreating } = useCreateX402Wallet();
  const [networkId, setNetworkId] = useState(defaultNetworkId ?? '');
  const [type, setType] = useState<X402WalletType>(defaultType);
  const [keySource, setKeySource] = useState<X402WalletKeySource>('generate');
  const [privateKey, setPrivateKey] = useState('');
  const [keyError, setKeyError] = useState<string | null>(null);
  const [networkError, setNetworkError] = useState<string | null>(null);
  // Set once a generated key comes back, switching the dialog to its backup phase.
  const [backup, setBackup] = useState<{ address: string; privateKey: string } | null>(null);
  const networkSelectId = useId();
  const networkErrorId = useId();
  const directionLabelId = useId();

  const lockedNetwork = isNetworkLocked
    ? (networks.find((network) => network.id === networkId) ?? null)
    : null;
  const typeOption = WALLET_TYPE_OPTIONS.find((option) => option.value === type);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!networkId) {
      setNetworkError('Select the chain this wallet operates on.');
      return;
    }
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
    const created = await createWallet({ networkId, type, keySource, privateKey: importedKey });
    if (!created) return;
    if (keySource === 'generate' && created.privateKey) {
      setBackup({ address: created.address, privateKey: created.privateKey });
      return;
    }
    // Imported wallets need no backup step: the operator already holds the key.
    if (keySource === 'import') toast.success('Wallet created');
    onSaved();
  };

  return (
    <Dialog
      open={open}
      // While the generated key is on screen and unconfirmed it is the only copy that
      // exists, so block accidental dismissal until the operator confirms the backup.
      onOpenChange={(value) => {
        if (!value && !backup) onClose();
      }}
    >
      <DialogContent className="sm:max-w-[480px]" hideClose={Boolean(backup)}>
        {backup ? (
          <div className="space-y-5">
            <DialogHeader>
              <div className="mx-auto mb-1 flex size-11 items-center justify-center rounded-full bg-primary/10 ring-1 ring-primary/20">
                <KeyRound className="size-5 text-primary" aria-hidden />
              </div>
              <DialogTitle className="text-center">Back up your private key</DialogTitle>
              <DialogDescription className="text-center">
                Store this key securely. You need it to recover the wallet, and we cannot recover it
                for you.
              </DialogDescription>
            </DialogHeader>
            <WalletKeyBackupPanel
              type={type}
              address={backup.address}
              privateKey={backup.privateKey}
              onConfirmed={onSaved}
              isDialog
            />
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-5">
            <DialogHeader>
              <DialogTitle>
                {isTypeLocked && typeOption
                  ? `Create ${typeOption.label} wallet`
                  : 'Create managed wallet'}
              </DialogTitle>
              <DialogDescription>
                {isTypeLocked && typeOption
                  ? typeOption.hint
                  : 'Each wallet has one direction and works on one chain. Keys are stored encrypted.'}
              </DialogDescription>
            </DialogHeader>

            {lockedNetwork ? (
              <div className="flex items-center justify-between rounded-lg border bg-muted/30 px-3 py-2 text-sm">
                <span className="text-muted-foreground">Chain</span>
                <span className="font-medium">{lockedNetwork.displayName}</span>
              </div>
            ) : (
              <div className="space-y-2">
                <Label htmlFor={networkSelectId} className="text-sm font-medium">
                  Chain
                </Label>
                <Select
                  value={networkId}
                  onValueChange={(value) => {
                    setNetworkId(value);
                    setNetworkError(null);
                  }}
                  disabled={networksLoading}
                >
                  <SelectTrigger
                    id={networkSelectId}
                    aria-invalid={!!networkError}
                    aria-describedby={networkError ? networkErrorId : undefined}
                  >
                    <SelectValue
                      placeholder={networksLoading ? 'Loading chains…' : 'Select a chain'}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {networks.map((network) => (
                        <SelectItem key={network.id} value={network.id}>
                          {network.displayName}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                {networkError ? (
                  <p id={networkErrorId} className="text-xs text-destructive">
                    {networkError}
                  </p>
                ) : (
                  <p className="text-xs leading-snug text-muted-foreground">
                    The wallet can only send and settle on this chain.
                  </p>
                )}
              </div>
            )}

            {!isTypeLocked && (
              <div className="space-y-2">
                <p id={directionLabelId} className="text-sm font-medium">
                  Direction
                </p>
                <div
                  role="radiogroup"
                  aria-labelledby={directionLabelId}
                  className="grid gap-2 sm:grid-cols-2"
                >
                  {WALLET_TYPE_OPTIONS.map((option) => {
                    const OptionIcon = option.icon;
                    const isSelected = type === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        role="radio"
                        aria-checked={isSelected}
                        onClick={() => setType(option.value)}
                        className={cn(
                          'flex flex-col gap-1 rounded-lg border p-3 text-start transition-[background-color,border-color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                          isSelected
                            ? 'border-primary bg-primary/5 ring-1 ring-primary/40'
                            : 'border-border hover:bg-muted/50',
                        )}
                      >
                        <span className="flex items-center gap-2 text-sm font-medium">
                          <OptionIcon
                            className={cn(
                              'size-4',
                              isSelected ? 'text-primary' : 'text-muted-foreground',
                            )}
                            aria-hidden
                          />
                          {option.label}
                        </span>
                        <span className="text-xs leading-snug text-muted-foreground">
                          {option.hint}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

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

            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose} disabled={isCreating}>
                Cancel
              </Button>
              <Button type="submit" disabled={isCreating}>
                {isCreating ? 'Creating…' : 'Create wallet'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
