import { useId, useRef, useState } from 'react';
import { toast } from 'react-toastify';
import { ArrowDownToLine, Check, CheckCircle2, Copy, Eye, EyeOff, ShieldCheck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { CopyButton } from '@/components/ui/copy-button';
import { formatX402WalletType } from '@/lib/display-labels';
import { cn, copyToClipboard, shortenAddress } from '@/lib/utils';
import {
  buildPrivateKeyBackupText,
  privateKeyBackupFileName,
  type X402WalletType,
} from '@/lib/x402-wallet-key';

/**
 * One-time backup of a freshly generated private key. The server returns the key once and
 * never again, so the operator must confirm they saved it before `onConfirmed` is offered.
 * Mirrors the Cardano seed-phrase backup. Used by the create-wallet dialog and the x402
 * setup wizard, which each supply their own heading.
 */
export function WalletKeyBackupPanel({
  type,
  address,
  privateKey,
  confirmLabel = 'Done',
  onConfirmed,
  isConfirming = false,
  isDialog = false,
}: {
  type: X402WalletType;
  address: string;
  privateKey: string;
  confirmLabel?: string;
  onConfirmed: () => void;
  isConfirming?: boolean;
  /** Nested inside a dialog: the download confirmation must stack above that overlay. */
  isDialog?: boolean;
}) {
  const [isRevealed, setIsRevealed] = useState(false);
  const [isConfirmed, setIsConfirmed] = useState(false);
  const [isDownloadConfirmOpen, setIsDownloadConfirmOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const confirmId = useId();

  const reveal = () => {
    setIsRevealed(true);
    // The overlay button unmounts on reveal; keep focus on the matching Hide control.
    queueMicrotask(() => toggleRef.current?.focus());
  };

  const download = () => {
    setIsDownloadConfirmOpen(false);
    const url = URL.createObjectURL(
      new Blob([buildPrivateKeyBackupText({ type, address, privateKey })], {
        type: 'text/plain',
      }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = privateKeyBackupFileName(address);
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5">
        <ShieldCheck
          className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-400"
          aria-hidden
        />
        <p className="text-xs leading-snug text-amber-900 dark:text-amber-200">
          Never share this key or store it online. Anyone who has it can move this wallet’s funds.
        </p>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <Badge variant="secondary" className="gap-1.5 px-2.5">
            <CheckCircle2 className="size-3 text-green-700 dark:text-green-500" aria-hidden />
            Wallet created
          </Badge>
          <span className="text-xs text-muted-foreground">{formatX402WalletType(type)}</span>
        </div>

        <div className="flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2">
          <span className="flex-1 truncate font-mono text-xs text-muted-foreground" title={address}>
            {shortenAddress(address, 12)}
          </span>
          <CopyButton value={address} className="size-7 shrink-0" />
        </div>

        <div className="relative rounded-lg border border-dashed bg-muted/30 p-3">
          <p
            className={cn(
              'select-none break-all font-mono text-sm leading-relaxed text-foreground/80 transition-[filter] duration-150',
              !isRevealed && 'blur-md',
            )}
            aria-hidden={!isRevealed}
          >
            {privateKey}
          </p>
          {!isRevealed && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="absolute inset-0 m-auto h-8 w-fit gap-1.5 px-3"
              onClick={reveal}
            >
              <Eye className="size-3.5" aria-hidden /> Reveal private key
            </Button>
          )}
        </div>

        <div className="flex gap-2">
          <Button
            ref={toggleRef}
            type="button"
            variant="outline"
            size="sm"
            className="gap-1.5"
            aria-pressed={isRevealed}
            onClick={() => setIsRevealed((value) => !value)}
          >
            {isRevealed ? (
              <EyeOff className="size-3.5" aria-hidden />
            ) : (
              <Eye className="size-3.5" aria-hidden />
            )}
            {isRevealed ? 'Hide' : 'Show'}
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
                toast.error('Could not copy the private key. Reveal it and copy it by hand.');
              }
            }}
          >
            <Copy className="size-3.5" aria-hidden /> Copy
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="flex-1 gap-1.5"
            onClick={() => setIsDownloadConfirmOpen(true)}
          >
            <ArrowDownToLine className="size-3.5" aria-hidden /> Download
          </Button>
        </div>
      </div>

      <div
        className={cn(
          'flex items-start gap-3 rounded-lg border p-3 transition-[background-color,border-color] duration-150',
          isConfirmed ? 'border-green-500/30 bg-green-500/5' : 'border-border bg-muted/30',
        )}
      >
        <Checkbox
          id={confirmId}
          checked={isConfirmed}
          onCheckedChange={(value) => setIsConfirmed(value === true)}
          className="mt-0.5"
        />
        <label
          htmlFor={confirmId}
          className="cursor-pointer text-sm leading-relaxed text-muted-foreground"
        >
          I have saved this private key in a secure place and understand it cannot be recovered if
          lost.
        </label>
      </div>

      <div className="flex justify-end">
        <Button
          type="button"
          disabled={!isConfirmed || isConfirming}
          onClick={onConfirmed}
          className="gap-1.5"
        >
          <Check className="size-4" aria-hidden /> {isConfirming ? 'Saving…' : confirmLabel}
        </Button>
      </div>

      <ConfirmDialog
        open={isDownloadConfirmOpen}
        onClose={() => setIsDownloadConfirmOpen(false)}
        title="Download private key file?"
        description="This saves your private key as an unencrypted .txt file. Anyone with the file can move this wallet's funds. Continue only if you will store it securely."
        onConfirm={download}
        elevatedChildStack={isDialog}
      />
    </div>
  );
}
