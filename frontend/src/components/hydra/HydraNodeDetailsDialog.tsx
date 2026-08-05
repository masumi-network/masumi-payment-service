/**
 * One connected node: what it is running, and the head processes on it.
 *
 * This used to open with a block telling the operator to hand a counterparty
 * their service URL and wallet address. That flow no longer exists, invites
 * carry the address and the endpoint it named was deleted, so it was three
 * paragraphs of instructions for a screen that would 404. It is gone.
 *
 * What is left is ordered by how often it is read: the node's state, then its
 * heads and the two things you do to them (back up the keys, move the fuel),
 * then the version and hash material that only matters when a head refuses to
 * open. That last part collapses, because it is read once a month at most.
 */

import { useState } from 'react';
import { KeyRound, Loader2, MoreHorizontal, Server } from 'lucide-react';
import { toast } from 'react-toastify';
import { useResync } from '@/lib/hooks/useResync';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useAppContext } from '@/lib/contexts/AppContext';
import { formatDateTime } from '@/lib/format-date';
import { fundHydraNode, withdrawHydraNodeFunds } from '@/lib/hooks/useHydraHeads';
import { useHydraLocalParticipants } from '@/lib/hooks/useHydraHeads';
import { BackUpNodeKeysDialog } from '@/components/hydra/BackUpNodeKeysDialog';
import { HydraDetailSection } from '@/components/hydra/HydraDetailSection';
import { HydraNotice } from '@/components/hydra/HydraNotice';
import { HydraWalletLink } from '@/components/hydra/HydraWalletLink';
import type { HydraHost } from '@/lib/hooks/useHydraHosts';
import { NodeFundsHint } from '@/components/hydra/hydra-hints';

type HydraNodeDetailsDialogProps = {
  host: HydraHost | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

function ada(lovelace: string): string {
  return `${(Number(lovelace) / 1_000_000).toFixed(2)} ADA`;
}

/** One reading, with its label above it. Values are copyable when they are worth copying. */
function Field({
  label,
  value,
  hint,
  copyable,
}: {
  label: string;
  value: string;
  hint?: string;
  copyable?: boolean;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
        {copyable && value !== '—' && <CopyButton value={value} />}
      </div>
      <p className="break-all font-mono text-xs">{value}</p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border px-3 py-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="truncate text-sm font-medium">{value}</p>
    </div>
  );
}

function shortHash(value: string | null): string {
  if (!value) return '—';
  return value.replace(/^sha256:/, '').slice(0, 16) + '…';
}

export function HydraNodeDetailsDialog({ host, open, onOpenChange }: HydraNodeDetailsDialogProps) {
  const { apiClient } = useAppContext();
  const resync = useResync();
  const { participants, refetch: refetchParticipants } = useHydraLocalParticipants(
    undefined,
    host?.id,
  );
  const [backUpId, setBackUpId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function handleWithdraw(participantId: string) {
    setBusyId(participantId);
    try {
      const result = await withdrawHydraNodeFunds(apiClient, { id: participantId });
      // A refusal is the normal answer here, not a failure: a node still serving
      // a live head keeps its fuel on purpose, and saying "error" would suggest
      // otherwise.
      toast[result.txHash === null ? 'info' : 'success'](
        result.txHash === null
          ? (result.reason ?? 'Nothing to send back')
          : `Sending ${ada(result.balanceLovelace)} back to the wallet`,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The withdrawal failed');
      await resync('hydra', 'wallets');
    } finally {
      setBusyId(null);
    }
  }

  async function handleFund(participantId: string) {
    setBusyId(participantId);
    try {
      const result = await fundHydraNode(apiClient, { id: participantId });
      toast.success(
        result.transferredLovelace === null
          ? `Already funded, holding ${ada(result.balanceLovelace)}`
          : `Sending ${ada(result.transferredLovelace)} to the node`,
      );
      await resync('hydra', 'wallets');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The transfer failed');
    } finally {
      setBusyId(null);
    }
  }

  if (!host) return null;

  const neverProbed = host.lastHealthAt === null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            <Server className="h-4 w-4" />
            {host.name}
            <Badge variant="outline">{host.status}</Badge>
            <Badge variant="outline">{host.network}</Badge>
          </DialogTitle>
          <DialogDescription className="break-all">{host.baseUrl}</DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="grid gap-2 sm:grid-cols-3">
            <Stat label="Heads" value={String(host.participantCount)} />
            <Stat label="hydra-node" value={host.hydraVersion?.split('-')[0] ?? 'not probed'} />
            <Stat
              label="Last checked"
              value={neverProbed ? 'never' : formatDateTime(host.lastHealthAt ?? '')}
            />
          </div>

          {host.lastHealthError && (
            <HydraNotice tone="error">
              <p>{host.lastHealthError}</p>
            </HydraNotice>
          )}

          {!host.hasAdminToken && (
            <HydraNotice tone="warn">
              <p>
                No admin key stored. This node keeps its heads running but cannot start a new one.
                Add the key from Edit to open heads here again.
              </p>
            </HydraNotice>
          )}

          <section className="space-y-2">
            <div className="flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold">Head processes</h3>
              <NodeFundsHint />
            </div>
            {participants.length === 0 ? (
              <p className="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
                No heads on this node yet.
              </p>
            ) : (
              <ul className="divide-y rounded-md border">
                {participants.map((participant) => (
                  <li
                    key={participant.id}
                    className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5"
                  >
                    {/* Led by the wallet and the head state, because that is
                        what an operator is looking for. The node's own id is a
                        UUID that means something only to the Host. */}
                    <div className="min-w-0 space-y-1">
                      <div className="flex items-center gap-2">
                        <HydraWalletLink
                          address={participant.Wallet?.walletAddress}
                          network={host.network}
                          shorten={10}
                        />
                        <Badge variant="outline">
                          {participant.HydraHead?.status ?? 'No head yet'}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {participant.keysDisclosedAt
                          ? `Keys taken ${formatDateTime(participant.keysDisclosedAt)}`
                          : 'Keys have never been backed up'}
                      </p>
                    </div>
                    <div className="flex items-center gap-1">
                      {busyId === participant.id && <Loader2 className="h-4 w-4 animate-spin" />}
                      {/* Backing up is the one an operator comes here to do, and
                          it can only be done once, so it stays a button while
                          the money actions sit behind the menu. */}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={Boolean(participant.keysDisclosedAt)}
                        onClick={() => setBackUpId(participant.id)}
                      >
                        {participant.keysDisclosedAt ? 'Keys taken' : 'Back up keys'}
                      </Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            disabled={busyId === participant.id}
                            aria-label="More actions for this head process"
                          >
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => void handleFund(participant.id)}>
                            Top up its ADA now
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => void handleWithdraw(participant.id)}>
                            Send leftovers back
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Read when a head will not open and never otherwise: two nodes whose
              scripts or ledger parameters differ cannot share a head, and that
              only shows up as a failure much later. */}
          <HydraDetailSection
            title="Version and hashes"
            summary={neverProbed ? 'Not probed yet' : (host.hydraVersion?.split('-')[0] ?? '—')}
          >
            {neverProbed ? (
              <p className="text-xs text-muted-foreground">
                Nothing yet. Press Check on the node to read this.
              </p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field
                  label="Scripts"
                  value={shortHash(host.scriptCatalogueHash)}
                  hint="Both sides must match, or the head cannot be opened at all."
                />
                <Field
                  label="Ledger parameters"
                  value={shortHash(host.ledgerParamsHash)}
                  hint="A mismatch shows up at the first spend inside the head, not here."
                />
                <Field label="Control URL" value={host.baseUrl} copyable />
                <Field
                  label="Peers dial"
                  value={host.publicPeerHost}
                  hint="Ports are handed out per head; the invite carries the full address."
                />
              </div>
            )}
          </HydraDetailSection>
        </div>
      </DialogContent>

      <BackUpNodeKeysDialog
        open={backUpId !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setBackUpId(null);
        }}
        participantId={backUpId}
        onDone={() => void refetchParticipants()}
      />
    </Dialog>
  );
}
