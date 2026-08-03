/**
 * One-time backup of a node's signing keys.
 *
 * The Hydra Host generates these keys and discloses them exactly once, at
 * provisioning; the payment service holds the only other copy. This dialog is
 * the operator's single chance to take one off-site, and the server seals the
 * path as it answers — so the keys are hidden until asked for, and the dialog
 * refuses to close as "done" until the operator says they have them.
 *
 * Deliberately shaped like the wallet mnemonic flow: reveal, copy, confirm.
 */

import { useState } from 'react';
import { AlertTriangle, Eye, EyeOff, KeyRound, Loader2 } from 'lucide-react';
import { toast } from 'react-toastify';
import { Button } from '@/components/ui/button';
import { HydraNotice } from '@/components/hydra/HydraNotice';
import { Checkbox } from '@/components/ui/checkbox';
import { CopyButton } from '@/components/ui/copy-button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { useAppContext } from '@/lib/contexts/AppContext';
import { revealHydraNodeKeys, type HydraNodeKeys } from '@/lib/hooks/useHydraHeads';

type BackUpNodeKeysDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Local participant whose node keys to back up. */
  participantId: string | null;
  onDone: () => void;
};

function SecretField({ label, value }: { label: string; value: string }) {
  const [revealed, setRevealed] = useState(false);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Label>{label}</Label>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => setRevealed((current) => !current)}
            aria-label={revealed ? `Hide ${label}` : `Reveal ${label}`}
          >
            {revealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </Button>
          <CopyButton value={value} />
        </div>
      </div>
      <p
        className="max-h-28 overflow-auto break-all rounded-md border bg-muted/30 px-3 py-2 font-mono text-xs"
        data-revealed={revealed}
      >
        {revealed ? value : '•'.repeat(Math.min(value.length, 64))}
      </p>
    </div>
  );
}

export function BackUpNodeKeysDialog({
  open,
  onOpenChange,
  participantId,
  onDone,
}: BackUpNodeKeysDialogProps) {
  const { apiClient } = useAppContext();
  const [keys, setKeys] = useState<HydraNodeKeys | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [saved, setSaved] = useState(false);

  async function handleReveal() {
    if (!participantId) return;
    setIsLoading(true);
    try {
      setKeys(await revealHydraNodeKeys(apiClient, { id: participantId }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to read the node keys');
    } finally {
      setIsLoading(false);
    }
  }

  function handleClose(nextOpen: boolean) {
    if (!nextOpen) {
      setKeys(null);
      setSaved(false);
    }
    onOpenChange(nextOpen);
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-4 w-4" />
            Back up this node&apos;s keys
          </DialogTitle>
          <DialogDescription>
            These identify the node on chain and sign for it in the head. They are shown once.
          </DialogDescription>
        </DialogHeader>

        {keys === null ? (
          <div className="space-y-4">
            <HydraNotice tone="warn">
              <p>
                Showing them seals this: the service will not hand these keys out a second time.
                Have somewhere to put them before you continue.
              </p>
            </HydraNotice>
            <p className="text-xs text-muted-foreground">
              Normal operation does not need this backup. The service and the node each hold a copy.
              It matters only if you lose the node&apos;s storage.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <SecretField label="Hydra signing key" value={keys.hydraSigningKey} />
            {keys.cardanoSigningKey === null ? (
              <p className="text-xs text-muted-foreground">
                This node was provisioned before Cardano keys were kept here, so only the Hydra key
                is available. The Cardano key is on the node itself.
              </p>
            ) : (
              <SecretField label="Cardano signing key" value={keys.cardanoSigningKey} />
            )}

            <label className="flex items-start gap-2 rounded-md border px-3 py-2 text-sm">
              <Checkbox
                checked={saved}
                onCheckedChange={(checked) => setSaved(checked === true)}
                aria-label="Confirm the keys are saved"
              />
              <span>I have saved both keys somewhere safe.</span>
            </label>
          </div>
        )}

        <DialogFooter>
          {keys === null ? (
            <>
              <Button type="button" variant="outline" onClick={() => handleClose(false)}>
                Not now
              </Button>
              <Button type="button" onClick={() => void handleReveal()} disabled={isLoading}>
                {isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
                Reveal keys
              </Button>
            </>
          ) : (
            <Button
              type="button"
              disabled={!saved}
              onClick={() => {
                onDone();
                handleClose(false);
              }}
            >
              Done
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
