import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import {
  ArrowDownToLine,
  Check,
  CheckCircle2,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Pencil,
  Plus,
  ShieldCheck,
  ShoppingCart,
  Store,
  Trash2,
  Wallet as WalletIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { Spinner } from '@/components/ui/spinner';
import { CopyButton } from '@/components/ui/copy-button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { RefreshButton } from '@/components/RefreshButton';
import { useAppContext } from '@/lib/contexts/AppContext';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useX402WalletsPaginated } from '@/lib/hooks/useX402';
import { cn, copyToClipboard, handleApiCall, shortenAddress } from '@/lib/utils';
import { extractApiPayload } from '@/lib/api-response';
import { postX402Wallets, postX402WalletsDelete, X402Wallet } from '@/lib/api/generated';
import { EditWalletNoteDialog, WalletBalanceDialog } from '@/components/x402/WalletExtras';

const PRIVATE_KEY_REGEX = /^0x[a-fA-F0-9]{64}$/;

type WalletType = X402Wallet['type'];

const WALLET_TYPE_LABEL: Record<WalletType, string> = {
  Purchasing: 'Purchasing · outbound',
  Selling: 'Selling · facilitator',
};

const WALLET_TYPE_OPTIONS: Array<{
  value: WalletType;
  label: string;
  hint: string;
  icon: typeof ShoppingCart;
}> = [
  {
    value: 'Purchasing',
    label: 'Purchasing',
    hint: 'Funds outbound payments (budgets) — the buy side.',
    icon: ShoppingCart,
  },
  {
    value: 'Selling',
    label: 'Selling',
    hint: 'Settles inbound payments as a chain facilitator — the sell side.',
    icon: Store,
  },
];

export function WalletsTab() {
  const { apiClient } = useAppContext();
  const queryClient = useQueryClient();
  const { wallets, isLoading, isRefetching, refetch, hasMore, isFetchingNextPage, loadMore } =
    useX402WalletsPaginated();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [retiringId, setRetiringId] = useState<string | null>(null);
  const [balanceWallet, setBalanceWallet] = useState<X402Wallet | null>(null);
  const [editWallet, setEditWallet] = useState<X402Wallet | null>(null);
  const [walletToRetire, setWalletToRetire] = useState<X402Wallet | null>(null);

  const confirmRetire = async () => {
    if (!walletToRetire) return;
    const id = walletToRetire.id;
    setRetiringId(id);
    await handleApiCall(() => postX402WalletsDelete({ client: apiClient, body: { id } }), {
      onSuccess: () => {
        toast.success('Wallet retired');
        // Invalidate the whole 'x402-wallets' key space (paginated list AND the eager,
        // type-filtered picker queries used by the Chains/Budgets/Alerts dialogs) so a
        // retired wallet disappears from every picker immediately, not after staleTime.
        queryClient.invalidateQueries({ queryKey: ['x402-wallets'] });
        // Retiring disables this wallet's budgets and detaches it as a chain facilitator,
        // so refresh those caches too.
        queryClient.invalidateQueries({ queryKey: ['x402-budgets'] });
        queryClient.invalidateQueries({ queryKey: ['x402-networks'] });
      },
      onFinally: () => {
        setRetiringId(null);
        setWalletToRetire(null);
      },
      errorMessage: 'Failed to retire wallet',
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Managed EVM wallets are split by direction: Purchasing wallets fund outbound x402
          payments, Selling wallets settle inbound ones as chain facilitators. Private keys are
          stored encrypted and never leave the server.
        </p>
        <div className="flex items-center gap-2">
          <RefreshButton onRefresh={refetch} isRefreshing={isRefetching} />
          <Button onClick={() => setDialogOpen(true)} className="flex items-center gap-2">
            <Plus className="h-4 w-4" />
            Create wallet
          </Button>
        </div>
      </div>

      <div className="border rounded-lg overflow-x-auto">
        <table className="w-full">
          <thead className="bg-muted/30 dark:bg-muted/15">
            <tr className="border-b">
              <th scope="col" className="p-4 text-left text-sm font-medium text-muted-foreground">
                Address
              </th>
              <th scope="col" className="p-4 text-left text-sm font-medium text-muted-foreground">
                Type
              </th>
              <th scope="col" className="p-4 text-left text-sm font-medium text-muted-foreground">
                Note
              </th>
              <th scope="col" className="p-4 text-left text-sm font-medium text-muted-foreground">
                Created
              </th>
              <th scope="col" className="p-4 text-right text-sm font-medium text-muted-foreground">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr>
                <td colSpan={5} className="py-10">
                  <div className="flex justify-center">
                    <Spinner />
                  </div>
                </td>
              </tr>
            ) : wallets.length === 0 ? (
              <tr>
                <td colSpan={5}>
                  <EmptyState
                    title="No managed wallets"
                    description="Create a wallet to fund and settle x402 payments."
                  />
                </td>
              </tr>
            ) : (
              wallets.map((wallet) => (
                <tr key={wallet.id} className="border-b last:border-0">
                  <td className="p-4">
                    <div className="flex items-center gap-1">
                      <span className="font-mono text-sm" title={wallet.address}>
                        {shortenAddress(wallet.address, 8)}
                      </span>
                      <CopyButton value={wallet.address} />
                    </div>
                  </td>
                  <td className="p-4 text-sm">{WALLET_TYPE_LABEL[wallet.type]}</td>
                  <td className="p-4 text-sm text-muted-foreground">
                    {wallet.note || <span className="italic opacity-60">—</span>}
                  </td>
                  <td className="p-4 text-sm text-muted-foreground">
                    {new Date(wallet.createdAt).toLocaleString()}
                  </td>
                  <td className="p-4 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => setBalanceWallet(wallet)}>
                        <WalletIcon className="h-4 w-4" />
                        Balances
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label="Rename wallet"
                        onClick={() => setEditWallet(wallet)}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        disabled={retiringId === wallet.id}
                        onClick={() => setWalletToRetire(wallet)}
                      >
                        <Trash2 className="h-4 w-4" />
                        {retiringId === wallet.id ? 'Retiring…' : 'Retire'}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {hasMore && (
        <div className="flex justify-center">
          <Button variant="outline" onClick={loadMore} disabled={isFetchingNextPage}>
            {isFetchingNextPage ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}

      <CreateWalletDialog
        key={dialogOpen ? 'open' : 'closed'}
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onSaved={() => {
          setDialogOpen(false);
          // Invalidate the whole 'x402-wallets' key space so the new wallet appears in the
          // list and in the type-filtered pickers (Chains facilitator, Budgets, Alerts).
          queryClient.invalidateQueries({ queryKey: ['x402-wallets'] });
          // A newly created wallet becomes selectable as a budget target.
          queryClient.invalidateQueries({ queryKey: ['x402-budgets'] });
        }}
      />

      <WalletBalanceDialog
        key={balanceWallet ? `bal-${balanceWallet.id}` : 'bal-closed'}
        wallet={balanceWallet}
        open={balanceWallet != null}
        onClose={() => setBalanceWallet(null)}
      />

      <EditWalletNoteDialog
        key={editWallet ? `note-${editWallet.id}` : 'note-closed'}
        wallet={editWallet}
        open={editWallet != null}
        onClose={() => setEditWallet(null)}
        onSaved={() => {
          setEditWallet(null);
          // The edited note also shows in the eager picker queries, so invalidate them all.
          queryClient.invalidateQueries({ queryKey: ['x402-wallets'] });
        }}
      />

      <ConfirmDialog
        open={walletToRetire !== null}
        onClose={() => setWalletToRetire(null)}
        title="Retire managed wallet"
        description="This disables the wallet's budgets and detaches it from any chain it facilitates, so a compromised key can no longer sign or settle. This cannot be undone."
        onConfirm={confirmRetire}
        isLoading={retiringId !== null && retiringId === walletToRetire?.id}
      />
    </div>
  );
}

type KeySource = 'generate' | 'import';

export function CreateWalletDialog({
  open,
  onClose,
  onSaved,
  defaultType = 'Purchasing',
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  defaultType?: WalletType;
}) {
  const { apiClient } = useAppContext();
  const [type, setType] = useState<WalletType>(defaultType);
  const [keySource, setKeySource] = useState<KeySource>('generate');
  const [privateKey, setPrivateKey] = useState('');
  const [showImportKey, setShowImportKey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  // Set once a generated key comes back, switching the dialog to its backup phase.
  const [backup, setBackup] = useState<{ address: string; privateKey: string } | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = privateKey.trim();
    if (keySource === 'import' && !PRIVATE_KEY_REGEX.test(trimmed)) {
      setError('Private key must be a 0x-prefixed 32-byte hex string');
      return;
    }
    setError(null);
    setIsSaving(true);
    await handleApiCall(
      () =>
        postX402Wallets({
          client: apiClient,
          body: keySource === 'import' ? { type, privateKey: trimmed } : { type },
        }),
      {
        onSuccess: (response) => {
          const created = extractApiPayload<{ address: string; privateKey: string | null }>(
            response,
          );
          if (keySource === 'generate') {
            // The generated key is the only copy and is returned exactly once. Show the
            // backup step when it is present; if it is somehow missing, never report plain
            // success — warn loudly so the operator retires this unrecoverable wallet.
            if (created?.privateKey) {
              setBackup({ address: created.address, privateKey: created.privateKey });
              return;
            }
            toast.error(
              'Wallet was created but its private key was not returned, so it cannot be recovered. Retire it and create a new one.',
            );
            onSaved();
            return;
          }
          // Imported wallets need no backup step — the operator already holds the key.
          toast.success('Wallet created');
          onSaved();
        },
        onFinally: () => setIsSaving(false),
        errorMessage: 'Failed to create wallet',
      },
    );
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
          <BackupKeyStep
            type={type}
            address={backup.address}
            privateKey={backup.privateKey}
            onDone={onSaved}
          />
        ) : (
          <form onSubmit={submit} className="space-y-5">
            <DialogHeader>
              <DialogTitle>Create managed wallet</DialogTitle>
              <DialogDescription>
                Wallets are split by direction. Keys are encrypted at rest and never leave the
                server.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-2">
              <Label className="text-sm font-medium">Direction</Label>
              <div className="grid grid-cols-2 gap-2">
                {WALLET_TYPE_OPTIONS.map((option) => {
                  const OptionIcon = option.icon;
                  const selected = type === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setType(option.value)}
                      aria-pressed={selected}
                      className={cn(
                        'flex flex-col gap-1 rounded-lg border p-3 text-left transition-colors',
                        selected
                          ? 'border-primary bg-primary/5 ring-1 ring-primary/40'
                          : 'border-border hover:bg-muted/50',
                      )}
                    >
                      <span className="flex items-center gap-2 text-sm font-medium">
                        <OptionIcon
                          className={cn(
                            'h-4 w-4',
                            selected ? 'text-primary' : 'text-muted-foreground',
                          )}
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

            <div className="space-y-2">
              <Label className="text-sm font-medium">Key</Label>
              <div className="grid grid-cols-2 gap-1 rounded-lg border bg-muted/40 p-1">
                {(
                  [
                    { value: 'generate', label: 'Generate new' },
                    { value: 'import', label: 'Import existing' },
                  ] as const
                ).map((tab) => (
                  <button
                    key={tab.value}
                    type="button"
                    onClick={() => {
                      setKeySource(tab.value);
                      setError(null);
                    }}
                    className={cn(
                      'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                      keySource === tab.value
                        ? 'bg-background text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              {keySource === 'generate' ? (
                <p className="text-xs leading-snug text-muted-foreground">
                  A fresh keypair is generated on the server. You will see the private key once,
                  right after creation, to back it up.
                </p>
              ) : (
                <div className="space-y-1.5">
                  <div className="relative">
                    <Textarea
                      placeholder="0x… 32-byte hex private key"
                      className="min-h-[76px] resize-none pr-10 font-mono text-xs"
                      autoComplete="off"
                      spellCheck={false}
                      value={privateKey}
                      onChange={(e) => setPrivateKey(e.target.value)}
                      style={
                        showImportKey
                          ? undefined
                          : ({
                              WebkitTextSecurity: 'disc',
                              textSecurity: 'disc',
                            } as React.CSSProperties)
                      }
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="absolute right-1.5 top-1.5 h-7 w-7 text-muted-foreground"
                      onClick={() => setShowImportKey((v) => !v)}
                      aria-label={showImportKey ? 'Hide private key' : 'Show private key'}
                    >
                      {showImportKey ? (
                        <EyeOff className="h-3.5 w-3.5" />
                      ) : (
                        <Eye className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Imported keys are stored encrypted and are never shown again.
                  </p>
                </div>
              )}
              {error && <p className="text-xs text-destructive">{error}</p>}
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose} disabled={isSaving}>
                Cancel
              </Button>
              <Button type="submit" disabled={isSaving}>
                {isSaving ? 'Creating…' : 'Create wallet'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * One-time backup of a freshly generated private key. The server returns the key once and
 * never again, so this gates the dialog: the operator must reveal and confirm they saved it
 * before continuing. Mirrors the Cardano seed-phrase backup step.
 */
function BackupKeyStep({
  type,
  address,
  privateKey,
  onDone,
}: {
  type: WalletType;
  address: string;
  privateKey: string;
  onDone: () => void;
}) {
  const [revealed, setRevealed] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [confirmDownloadOpen, setConfirmDownloadOpen] = useState(false);

  const performDownload = () => {
    setConfirmDownloadOpen(false);
    const contents = [
      'Masumi x402 managed wallet — PRIVATE KEY BACKUP',
      `Direction: ${type}`,
      `Address:   ${address}`,
      `Private key: ${privateKey}`,
      '',
      'Keep this file secret. Anyone with this key controls the wallet’s funds.',
    ].join('\n');
    const url = URL.createObjectURL(new Blob([contents], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `x402-wallet-${address.slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-5">
      <DialogHeader>
        <div className="mx-auto mb-1 flex h-11 w-11 items-center justify-center rounded-full bg-primary/10 ring-1 ring-primary/20">
          <KeyRound className="h-5 w-5 text-primary" />
        </div>
        <DialogTitle className="text-center">Back up your private key</DialogTitle>
        <DialogDescription className="text-center">
          Store this key securely. You need it to recover the wallet, and we cannot recover it for
          you.
        </DialogDescription>
      </DialogHeader>

      <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <p className="text-xs leading-snug text-amber-800 dark:text-amber-200">
          Never share this key or store it online. Anyone who has it can move this wallet’s funds.
        </p>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Badge variant="secondary" className="gap-1.5 px-2.5">
            <CheckCircle2 className="h-3 w-3 text-green-600 dark:text-green-500" />
            Wallet created
          </Badge>
          <span className="text-xs text-muted-foreground">{WALLET_TYPE_LABEL[type]}</span>
        </div>

        <div className="flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2">
          <span className="flex-1 truncate font-mono text-xs text-muted-foreground" title={address}>
            {shortenAddress(address, 12)}
          </span>
          <CopyButton value={address} className="h-7 w-7 shrink-0" />
        </div>

        <div className="relative rounded-lg border border-dashed bg-muted/30 p-3">
          <p
            className={cn(
              'select-none break-all font-mono text-xs leading-relaxed text-foreground/80 transition-[filter]',
              !revealed && 'blur-md',
            )}
            aria-hidden={!revealed}
          >
            {privateKey}
          </p>
          {!revealed && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="absolute inset-0 m-auto h-7 w-fit gap-1.5 px-3"
              onClick={() => setRevealed(true)}
            >
              <Eye className="h-3.5 w-3.5" /> Reveal private key
            </Button>
          )}
        </div>

        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => setRevealed((v) => !v)}
          >
            {revealed ? (
              <>
                <EyeOff className="h-3.5 w-3.5" /> Hide
              </>
            ) : (
              <>
                <Eye className="h-3.5 w-3.5" /> Show
              </>
            )}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="flex-1 gap-1.5"
            onClick={async () => {
              // Awaited so a blocked clipboard (e.g. plain-HTTP host) surfaces as an
              // error instead of a false success on an unrecoverable secret.
              if (await copyToClipboard(privateKey)) {
                toast.success('Private key copied');
              } else {
                toast.error('Failed to copy private key. Reveal and copy it manually.');
              }
            }}
          >
            <Copy className="h-3.5 w-3.5" /> Copy
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="flex-1 gap-1.5"
            onClick={() => setConfirmDownloadOpen(true)}
          >
            <ArrowDownToLine className="h-3.5 w-3.5" /> Download
          </Button>
        </div>
      </div>

      <label
        className={cn(
          'flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors',
          confirmed ? 'border-green-500/30 bg-green-500/5' : 'border-border bg-muted/30',
        )}
      >
        <Checkbox
          checked={confirmed}
          onCheckedChange={(value) => setConfirmed(value === true)}
          className="mt-0.5"
        />
        <span className="text-sm leading-relaxed text-muted-foreground">
          I have saved this private key in a secure place and understand it cannot be recovered if
          lost.
        </span>
      </label>

      <DialogFooter>
        <Button type="button" disabled={!confirmed} onClick={onDone} className="gap-1.5">
          <Check className="h-4 w-4" /> Done
        </Button>
      </DialogFooter>

      <ConfirmDialog
        open={confirmDownloadOpen}
        onClose={() => setConfirmDownloadOpen(false)}
        title="Download private key file?"
        description="This saves your private key as an unencrypted .txt file. Anyone with the file can move this wallet's funds. Continue only if you will store it securely."
        onConfirm={performDownload}
        // Nested inside the create-wallet dialog, so it must stack above that overlay.
        elevatedChildStack
      />
    </div>
  );
}
