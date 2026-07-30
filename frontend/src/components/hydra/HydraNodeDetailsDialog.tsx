/**
 * Everything about one connected Hydra node, including what to hand a counterparty.
 *
 * Opening a head with another organisation needs two values from each side —
 * the wallet the relation is with, and the service URL offers are delivered to —
 * and neither was visible anywhere in the UI. They are gathered here because
 * this is the page an operator is already on when they need them.
 */

import { AlertTriangle, KeyRound, Server } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { CopyButton } from '@/components/ui/copy-button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useWallets } from '@/lib/queries/useWallets';
import { useHydraLocalParticipants } from '@/lib/hooks/useHydraHeads';
import { BackUpNodeKeysDialog } from '@/components/hydra/BackUpNodeKeysDialog';
import type { HydraHost } from '@/lib/hooks/useHydraHosts';

type HydraNodeDetailsDialogProps = {
  host: HydraHost | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

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

function shortHash(value: string | null): string {
  if (!value) return '—';
  return value.replace(/^sha256:/, '').slice(0, 16) + '…';
}

export function HydraNodeDetailsDialog({ host, open, onOpenChange }: HydraNodeDetailsDialogProps) {
  const { wallets } = useWallets();
  const { participants, refetch: refetchParticipants } = useHydraLocalParticipants(
    undefined,
    host?.id,
  );
  const [backUpId, setBackUpId] = useState<string | null>(null);

  if (!host) return null;

  const neverProbed = host.lastHealthAt === null;
  // The origin only. The counterparty appends the handshake path itself, so a
  // URL ending in /api/v1 would be requested as /api/v1/api/v1/... and 404.
  const serviceUrl = typeof window === 'undefined' ? '' : window.location.origin;

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
          <DialogDescription>
            Runs one hydra-node process per head and generates each node&apos;s keys itself.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          <section className="space-y-3">
            <h3 className="text-sm font-semibold">Give these to your counterparty</h3>
            <p className="text-xs text-muted-foreground">
              They need both to open a head with you: the wallet identifies you on the relation, and
              the URL is where your service receives their offer.
            </p>
            <p className="text-xs text-muted-foreground">
              Only <span className="font-mono">/api/v1/hydra/handshake/offer</span> has to be
              reachable from their network — route that one path and nothing else. Never give them
              your Hydra node&apos;s URL or keys: those start and stop your node.
            </p>
            <div className="space-y-3 rounded-md border bg-muted/20 p-3">
              <Field
                label="Your service URL"
                value={serviceUrl}
                copyable
                hint="Paste into their “Counterparty service URL”. Origin only — no path."
              />
              {wallets.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No wallets on this payment source yet.
                </p>
              ) : (
                wallets.map((wallet) => (
                  <Field
                    key={wallet.id}
                    label={`Wallet · ${wallet.note?.trim() || wallet.type}`}
                    value={wallet.walletAddress}
                    copyable
                    hint="Paste into their “Counterparty wallet address”."
                  />
                ))
              )}
            </div>
            {wallets.length > 1 && (
              <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300">
                <AlertTriangle className="mr-1 inline h-3 w-3" />
                Send the wallet you will pick as <span className="font-medium">
                  Our wallet
                </span>{' '}
                when you create the relation. Offers are verified against that exact wallet, so a
                mismatch is rejected.
              </p>
            )}
          </section>

          <section className="space-y-3">
            <h3 className="text-sm font-semibold">Connection</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Control-plane URL" value={host.baseUrl} copyable />
              <Field
                label="Public peer host"
                value={host.publicPeerHost}
                hint="Ports are allocated per head; the counterparty learns the full host:port from the signed offer."
              />
              <Field label="Admin key" value={host.hasAdminToken ? 'stored' : 'not set'} />
              <Field label="Heads on this node" value={String(host.participantCount)} />
            </div>
          </section>

          <section className="space-y-3">
            <h3 className="text-sm font-semibold">What it reported</h3>
            {neverProbed ? (
              <p className="text-xs text-muted-foreground">
                Never probed. Press <span className="font-medium">Check</span> to fill this in.
              </p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="hydra-node" value={host.hydraVersion?.split('-')[0] ?? '—'} />
                <Field
                  label="Last checked"
                  value={new Date(host.lastHealthAt ?? '').toLocaleString()}
                />
                <Field
                  label="Script catalogue"
                  value={shortHash(host.scriptCatalogueHash)}
                  hint="Must match the counterparty's, or the head cannot be opened."
                />
                <Field
                  label="Ledger parameters"
                  value={shortHash(host.ledgerParamsHash)}
                  hint="A mismatch surfaces at first in-head spend, not here."
                />
              </div>
            )}
            {host.lastHealthError && (
              <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-400">
                {host.lastHealthError}
              </p>
            )}
          </section>

          <section className="space-y-2">
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <KeyRound className="h-4 w-4" />
              Keys
            </h3>
            <p className="text-xs text-muted-foreground">
              Generated on the node, one set per head, and never typed here. Each set can be handed
              over exactly once — after that the service refuses, so keep what you take.
            </p>
            {participants.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No heads on this node yet, so there are no keys to back up.
              </p>
            ) : (
              <ul className="divide-y rounded-md border">
                {participants.map((participant) => (
                  <li
                    key={participant.id}
                    className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="font-mono text-xs">
                        {participant.hostNodeId ?? participant.id}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {participant.keysDisclosedAt
                          ? `Backed up ${new Date(participant.keysDisclosedAt).toLocaleString()}`
                          : 'Never backed up'}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={Boolean(participant.keysDisclosedAt)}
                      onClick={() => setBackUpId(participant.id)}
                    >
                      {participant.keysDisclosedAt ? 'Sealed' : 'Export keys'}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>
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
