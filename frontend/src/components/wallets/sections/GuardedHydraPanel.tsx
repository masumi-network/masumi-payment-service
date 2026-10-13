import { useState } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, ChevronDown, Layers } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
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

const LOCATION = {
  L1: { label: 'On chain (L1)', variant: 'secondary' },
  L2: { label: 'In Hydra head', variant: 'success' },
  Unknown: { label: 'Moving', variant: 'processing' },
} as const;

function headLabel(head: HydraHead): string {
  return head.headIdentifier == null ? head.id : `Head ${head.headIdentifier.slice(0, 10)}…`;
}

function formatWhen(value: Date | string): string {
  return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function TransferRow({
  transfer,
  network,
  now,
  busy,
  onRecover,
}: {
  transfer: GuardedHydraTransfer;
  network: 'Preprod' | 'Mainnet';
  now: Date;
  busy: GuardedHydraAction | null;
  onRecover: (transferId: string) => void;
}) {
  const isDeposit = transfer.direction === 'Deposit';
  return (
    <div className="flex flex-col gap-1 px-4 py-2.5">
      <div className="flex items-center gap-2 text-sm">
        {isDeposit ? (
          <ArrowDownToLine className="h-3.5 w-3.5 text-muted-foreground" />
        ) : (
          <ArrowUpFromLine className="h-3.5 w-3.5 text-muted-foreground" />
        )}
        <span>{isDeposit ? 'Into head' : 'Back to L1'}</span>
        <Badge variant={STATUS_VARIANT[transfer.status]} className="ml-auto">
          {transfer.status}
        </Badge>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 pl-5 text-xs text-muted-foreground">
        <span>{formatWhen(transfer.createdAt)}</span>
        {isDeposit ? (
          <TxLink label="Tx" hash={transfer.txHash} network={network} fallback={null} />
        ) : (
          <InHeadTxId label="In-head tx" hash={transfer.txHash} />
        )}
      </div>
      {transfer.failureReason && (
        <div className="pl-5 text-xs text-muted-foreground">{transfer.failureReason}</div>
      )}
      {isRecoverable(transfer, now) && (
        <div className="pl-5">
          <Button
            variant="outline"
            size="sm"
            className="h-7"
            disabled={busy != null}
            onClick={() => onRecover(transfer.id)}
          >
            {busy === 'recover' && <Spinner size={12} />}
            Recover to L1
          </Button>
        </div>
      )}
    </div>
  );
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
  blockedReason,
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
  /** Why a move cannot be signed now; null when the owner wallet is ready. */
  blockedReason: string | null;
  busy: GuardedHydraAction | null;
  ownerWallet: React.ReactNode;
  onDeposit: (hydraHeadId: string) => void;
  onWithdraw: () => void;
  onRecover: (transferId: string) => void;
}) {
  const [selectedHeadId, setSelectedHeadId] = useState<string | null>(null);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const headId =
    openHeads.find((head) => head.id === selectedHeadId)?.id ?? openHeads[0]?.id ?? null;
  const now = new Date();
  const location = state == null ? null : LOCATION[state.location];
  const balance = state?.state ? formatLovelaceAsAda(state.state.lovelace) : null;
  const hasRecoverable = state?.transfers.some((transfer) => isRecoverable(transfer, now)) ?? false;
  const depositBlocked =
    blockedReason ??
    (openHeads.length === 0 ? 'No open head has this wallet as a participant' : null);

  return (
    <div className="overflow-hidden rounded-lg border">
      <div className="flex items-start justify-between gap-3 border-b px-4 py-3">
        <div className="flex items-start gap-2">
          <Layers className="mt-0.5 h-4 w-4 text-primary" />
          <div>
            <div className="text-sm font-medium">Hydra head</div>
            <div className="text-xs text-muted-foreground">
              Inside a head, purchases settle in seconds and cost no L1 fees.
            </div>
          </div>
        </div>
        {location && (
          <Badge variant={location.variant} className="shrink-0 whitespace-nowrap">
            {location.label}
          </Badge>
        )}
      </div>

      <div className="flex flex-col gap-3 px-4 py-3">
        {isLoading ? (
          <Spinner size={16} />
        ) : loadError ? (
          <div className="text-sm text-destructive">{loadError}</div>
        ) : state ? (
          <>
            {state.location !== 'Unknown' && ownerWallet}

            {state.location === 'L1' && (
              <div className="flex flex-col gap-2">
                {openHeads.length > 1 && (
                  <Select value={headId ?? undefined} onValueChange={setSelectedHeadId}>
                    <SelectTrigger className="h-9" aria-label="Head to move into">
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
                )}
                <Button
                  disabled={depositBlocked != null || busy != null || headId == null}
                  onClick={() => headId && onDeposit(headId)}
                >
                  {busy === 'deposit' ? (
                    <Spinner size={14} />
                  ) : (
                    <ArrowDownToLine className="h-4 w-4" />
                  )}
                  Move {balance ?? 'wallet'} into{' '}
                  {openHeads.length === 1 ? headLabel(openHeads[0]) : 'the head'}
                </Button>
                <div className="text-xs text-muted-foreground">
                  {depositBlocked ??
                    'You sign once. The head takes the wallet in after about 6 minutes; until then it stays on L1.'}
                </div>
              </div>
            )}

            {state.location === 'L2' && (
              <div className="flex flex-col gap-2">
                <Button
                  variant="outline"
                  disabled={blockedReason != null || busy != null}
                  onClick={onWithdraw}
                >
                  {busy === 'withdraw' ? (
                    <Spinner size={14} />
                  ) : (
                    <ArrowUpFromLine className="h-4 w-4" />
                  )}
                  Move {balance ?? 'wallet'} back to L1
                </Button>
                <div className="text-xs text-muted-foreground">
                  {blockedReason ??
                    'You sign once. The wallet is back on L1 within a minute or two.'}
                </div>
              </div>
            )}

            {state.location === 'Unknown' && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner size={14} />
                The wallet is moving between L1 and the head. This updates by itself.
              </div>
            )}

            {state.l1Error && state.location === 'L1' && (
              <div className="text-xs text-muted-foreground">{state.l1Error}</div>
            )}
          </>
        ) : null}
      </div>

      {state != null && state.transfers.length > 0 && (
        <Collapsible open={isHistoryOpen || hasRecoverable} onOpenChange={setIsHistoryOpen}>
          <CollapsibleTrigger className="flex w-full items-center justify-between border-t px-4 py-2 text-xs text-muted-foreground hover:bg-muted/50">
            Recent moves ({Math.min(state.transfers.length, SHOWN_TRANSFERS)})
            <ChevronDown
              className={`h-4 w-4 transition-transform ${isHistoryOpen || hasRecoverable ? 'rotate-180' : ''}`}
            />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="divide-y border-t">
              {state.transfers.slice(0, SHOWN_TRANSFERS).map((transfer) => (
                <TransferRow
                  key={transfer.id}
                  transfer={transfer}
                  network={network}
                  now={now}
                  busy={busy}
                  onRecover={onRecover}
                />
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}
