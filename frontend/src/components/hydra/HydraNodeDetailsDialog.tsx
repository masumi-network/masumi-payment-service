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
 *
 * The node's own actions live here too. They used to sit on a card behind a
 * dialog that nothing opened once the node strip replaced it, which left an
 * operator with a node they could read but not re-probe or disconnect. Check is
 * a button because a stale reading is the usual reason to open this at all;
 * disconnecting sits behind the menu.
 */

import { useState } from 'react';
import {
  KeyRound,
  Loader2,
  MoreHorizontal,
  PauseCircle,
  PlayCircle,
  RefreshCw,
  Server,
  Trash2,
} from 'lucide-react';
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
import {
  checkHydraHost,
  disconnectHydraHost,
  updateHydraHost,
  type HydraHost,
} from '@/lib/hooks/useHydraHosts';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
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
  copyValue,
}: {
  label: string;
  value: string;
  hint?: string;
  copyable?: boolean;
  /** What to copy when the shown value is abbreviated. Defaults to `value`. */
  copyValue?: string | null;
}) {
  const copied = copyValue ?? value;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
        {copyable && copied !== '—' && copied.length > 0 && <CopyButton value={copied} />}
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

/**
 * What draining does, spelled out.
 *
 * The name says what stops and leaves what continues to the imagination, and
 * the imagination gets it wrong: an operator who reads "stop taking new heads"
 * as "stop the node" will not touch it while a head is live. So the reassurance
 * is the middle paragraph, and it only appears when there is something to
 * reassure about.
 */
function drainingDescription(host: HydraHost, isDraining: boolean): string {
  if (isDraining) {
    return `${host.name} becomes eligible for new heads again. Nothing else changes: this only affects where the next head is placed.`;
  }

  const subject =
    host.participantCount === 1
      ? 'The head already on it keeps'
      : `The ${host.participantCount} heads already on it keep`;
  const running =
    host.participantCount === 0
      ? ''
      : `Nothing running is affected. ${subject} running, settling and paying exactly as now — no process is stopped and no money moves.\n\n`;

  return (
    `${host.name} stops being chosen for new heads. They go to another connected node, or opening one fails if this is your only node.\n\n` +
    running +
    'This is how you empty a node before disconnecting it: stop new heads, settle the ones left, then disconnect. Reversible at any point.'
  );
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
  const [isNodeBusy, setIsNodeBusy] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [isTogglingDraining, setIsTogglingDraining] = useState(false);
  const isDraining = host?.status === 'Draining';

  /**
   * Re-probe the node and record what it reports.
   *
   * This is the fix for a stale reading: the compatibility pins are read from
   * the service's environment at probe time, so a node that failed on a pin
   * keeps showing that error until it is checked again.
   */
  async function handleCheck() {
    if (!host) return;
    setIsNodeBusy(true);
    try {
      const checked = await checkHydraHost(apiClient, host.id);
      if (checked.status === 'Unreachable') {
        toast.error(checked.lastHealthError ?? `${host.name} could not be reached`);
      } else {
        toast.success(`${host.name} is ${checked.status.toLowerCase()}`);
      }
      await resync('hydra');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The check failed');
    } finally {
      setIsNodeBusy(false);
    }
  }

  async function handleToggleDraining() {
    if (!host) return;
    const next = isDraining ? 'Active' : 'Draining';
    setIsNodeBusy(true);
    try {
      await updateHydraHost(apiClient, { id: host.id, status: next });
      toast.success(
        next === 'Draining'
          ? `${host.name} takes no new heads. The ones on it keep running.`
          : `${host.name} takes new heads again`,
      );
      await resync('hydra');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The change failed');
    } finally {
      setIsNodeBusy(false);
      setIsTogglingDraining(false);
    }
  }

  async function handleDisconnect() {
    if (!host) return;
    // The confirmation stays up until the removal answers, so its spinner is
    // the one thing on screen while the service is still deciding — the server
    // refuses this outright when heads remain, and that refusal is the answer.
    setIsNodeBusy(true);
    try {
      await disconnectHydraHost(apiClient, host.id);
      toast.success(`Disconnected ${host.name}`);
      await resync('hydra');
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The node could not be disconnected');
    } finally {
      setIsNodeBusy(false);
      setIsDisconnecting(false);
    }
  }

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

          {/* Check sits directly under the reading it refreshes, and next to
              the error it most often clears. */}
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isNodeBusy}
              onClick={() => void handleCheck()}
            >
              {isNodeBusy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              Check now
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  disabled={isNodeBusy}
                  aria-label={`More actions for ${host.name}`}
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              {/* Both items carry a line of consequence. "Stop taking new
                  heads" is the one nobody guesses right: it sounds like it
                  stops the node, and it does not touch a single running head. */}
              <DropdownMenuContent align="start" className="max-w-80">
                <DropdownMenuItem
                  className="items-start gap-2"
                  onClick={() => setIsTogglingDraining(true)}
                >
                  {isDraining ? (
                    <PlayCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  ) : (
                    <PauseCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  )}
                  <span className="space-y-0.5">
                    <span className="block">
                      {isDraining ? 'Take new heads again' : 'Stop taking new heads'}
                    </span>
                    <span className="block text-xs font-normal text-muted-foreground">
                      {isDraining
                        ? 'Let new heads open here again.'
                        : 'New heads go to another node. Heads already running here are untouched.'}
                    </span>
                  </span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="items-start gap-2 text-red-600 focus:text-red-600 dark:text-red-400 dark:focus:text-red-400"
                  onClick={() => setIsDisconnecting(true)}
                >
                  <Trash2 className="mt-0.5 h-4 w-4 shrink-0" />
                  <span className="space-y-0.5">
                    <span className="block">Disconnect</span>
                    <span className="block text-xs font-normal text-muted-foreground">
                      This service forgets the node. The node itself keeps running.
                    </span>
                  </span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {host.lastHealthError && (
            <HydraNotice tone="error">
              <p>{host.lastHealthError}</p>
              <p className="mt-1">
                Fixed the cause? Press <span className="text-foreground">Check now</span> — this
                reading is from the last probe, not live.
              </p>
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
                {/* Copyable in full: pinning a reviewed node means pasting these
                    into HYDRA_EXPECTED_SCRIPT_CATALOGUE_HASH and the params
                    hash, and there is no other way to read the value. */}
                <Field
                  label="Scripts"
                  value={shortHash(host.scriptCatalogueHash)}
                  copyValue={host.scriptCatalogueHash}
                  copyable
                  hint="Both sides must match, or the head cannot be opened at all."
                />
                <Field
                  label="Ledger parameters"
                  value={shortHash(host.ledgerParamsHash)}
                  copyValue={host.ledgerParamsHash}
                  copyable
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

      {/* Draining reads as "stop the node" and is nothing of the kind, so the
          confirmation spends its words on what does not happen. It is also the
          first half of decommissioning, which is why it names the next step. */}
      <ConfirmDialog
        elevatedChildStack
        open={isTogglingDraining}
        onClose={() => setIsTogglingDraining(false)}
        title={isDraining ? `Take new heads on ${host.name} again?` : `Stop taking new heads?`}
        confirmLabel={isDraining ? 'Take new heads' : 'Stop taking new heads'}
        isLoading={isNodeBusy}
        description={drainingDescription(host, isDraining)}
        onConfirm={() => void handleToggleDraining()}
      />

      {/* Says what is removed, what is not, and what the operator is left
          holding. Disconnecting is a local forget, not a teardown: the Host
          keeps running every node it has, and once this service has forgotten
          it there is nothing here that can clean them up. */}
      <ConfirmDialog
        elevatedChildStack
        open={isDisconnecting}
        onClose={() => setIsDisconnecting(false)}
        title={`Disconnect ${host.name}?`}
        confirmLabel="Disconnect"
        isLoading={isNodeBusy}
        description={
          host.participantCount > 0
            ? `${host.participantCount} head(s) still run here. A head cannot be moved to another node, so disconnecting would put them out of reach — settle them first, and the removal will be refused until you have.\n\nStop taking new heads while you work through them.`
            : `This removes the node from this payment service only: its address, its stored tokens and its keys. Nothing is sent to the node.\n\nThe Hydra Host at ${host.baseUrl} keeps running, along with any hydra-node processes still provisioned on it. This service will no longer see or manage them, so if you are decommissioning the machine, check the Host's own node list and remove what is left there — afterwards there is nothing here that can reach it.\n\nYou can connect it again later with the same address and tokens.`
        }
        onConfirm={() => void handleDisconnect()}
      />
    </Dialog>
  );
}
