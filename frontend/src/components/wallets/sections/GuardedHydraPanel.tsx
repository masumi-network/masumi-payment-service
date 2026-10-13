import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { InHeadTxId, TxLink } from '@/components/hydra/TxLink';
import { formatLovelaceAsAda } from '@/lib/format-lovelace-display';
import type { HydraHead } from '@/lib/hooks/hydra/types';
import {
  isRecoverable,
  type GuardedHydraState,
  type GuardedHydraTransfer,
} from '@/components/wallets/guarded-hydra-utils';
import type { GuardedHydraAction } from '@/components/wallets/useGuardedHydra';

const SHOWN_TRANSFERS = 5;

const STATUS_VARIANT: Record<
  GuardedHydraTransfer['status'],
  'success' | 'pending' | 'destructive' | 'secondary'
> = {
  Prepared: 'pending',
  Submitted: 'pending',
  Confirmed: 'success',
  Expired: 'secondary',
  Failed: 'destructive',
};

function headLabel(head: HydraHead): string {
  return head.headIdentifier == null ? head.id : `${head.headIdentifier.slice(0, 12)}…`;
}

/**
 * Where the guarded wallet is (L1 or inside a Hydra head) and the moves between
 * them. Renders and forwards only; useGuardedHydra owns the state.
 */
export function GuardedHydraPanel({
  network,
  state,
  isLoading,
  loadError,
  openHeads,
  canSign,
  busy,
  ownerWallet,
  onDeposit,
  onWithdraw,
  onRecover,
}: {
  network: 'Preprod' | 'Mainnet';
  state: GuardedHydraState | null;
  isLoading: boolean;
  loadError: string | null;
  openHeads: HydraHead[];
  /** False while no connected wallet can sign for the owner. */
  canSign: boolean;
  busy: GuardedHydraAction | null;
  ownerWallet: React.ReactNode;
  onDeposit: (hydraHeadId: string) => void;
  onWithdraw: () => void;
  onRecover: (transferId: string) => void;
}) {
  const [selectedHeadId, setSelectedHeadId] = useState<string | null>(null);
  const headId = selectedHeadId ?? openHeads[0]?.id ?? null;
  const now = new Date();

  return (
    <div className="flex flex-col gap-2 mt-2 border-t pt-3">
      <div className="text-xs text-muted-foreground">Hydra head</div>
      {isLoading ? (
        <Spinner size={16} />
      ) : loadError ? (
        <div className="text-sm text-destructive">{loadError}</div>
      ) : state ? (
        <>
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Location</span>
            <Badge variant={state.location === 'Unknown' ? 'pending' : 'secondary'}>
              {state.location === 'L2'
                ? 'Inside a head (L2)'
                : state.location === 'L1'
                  ? 'On chain (L1)'
                  : 'Moving'}
            </Badge>
            {state.state && <span>{formatLovelaceAsAda(state.state.lovelace)}</span>}
          </div>
          {state.l1Error && state.location !== 'L2' && (
            <div className="text-xs text-muted-foreground">{state.l1Error}</div>
          )}

          {ownerWallet}

          {state.location === 'L1' &&
            (openHeads.length === 0 ? (
              <div className="text-xs text-muted-foreground">
                No open head has this hot wallet as a participant.
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <Select value={headId ?? undefined} onValueChange={setSelectedHeadId}>
                  <SelectTrigger className="h-8 w-56" aria-label="Head to deposit into">
                    <SelectValue placeholder="Choose a head" />
                  </SelectTrigger>
                  <SelectContent>
                    {openHeads.map((head) => (
                      <SelectItem key={head.id} value={head.id}>
                        {headLabel(head)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  className="h-8"
                  disabled={!canSign || busy != null || headId == null}
                  onClick={() => headId && onDeposit(headId)}
                >
                  {busy === 'deposit' ? <Spinner size={14} /> : null}
                  Move into head
                </Button>
              </div>
            ))}
          {state.location === 'L2' && (
            <Button
              size="sm"
              className="h-8 w-fit"
              disabled={!canSign || busy != null}
              onClick={onWithdraw}
            >
              {busy === 'withdraw' ? <Spinner size={14} /> : null}
              Move to L1
            </Button>
          )}
          {state.location === 'Unknown' && (
            <div className="text-xs text-muted-foreground">
              The wallet is between L1 and the head. This view refreshes every few seconds.
            </div>
          )}

          {state.transfers.length > 0 && (
            <div className="flex flex-col gap-1">
              {state.transfers.slice(0, SHOWN_TRANSFERS).map((transfer) => (
                <div key={transfer.id} className="flex flex-wrap items-center gap-2 text-xs">
                  <Badge variant={STATUS_VARIANT[transfer.status]}>{transfer.status}</Badge>
                  <span>{transfer.direction === 'Deposit' ? 'Into head' : 'To L1'}</span>
                  <span className="text-muted-foreground">
                    {new Date(transfer.createdAt).toLocaleString()}
                  </span>
                  {transfer.direction === 'Deposit' ? (
                    <TxLink
                      label="Deposit"
                      hash={transfer.txHash}
                      network={network}
                      fallback={null}
                    />
                  ) : (
                    <InHeadTxId label="Decommit" hash={transfer.txHash} />
                  )}
                  {isRecoverable(transfer, now) && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-6"
                      disabled={busy != null}
                      onClick={() => onRecover(transfer.id)}
                    >
                      {busy === 'recover' ? <Spinner size={12} /> : null}
                      Recover to L1
                    </Button>
                  )}
                  {transfer.failureReason && (
                    <span className="w-full text-muted-foreground">{transfer.failureReason}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
