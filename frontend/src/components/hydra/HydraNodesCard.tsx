/**
 * Connected Hydra nodes.
 *
 * Shows what each node reported when last probed, because two things silently
 * cross the boundary between this service and a node and both fail late and
 * confusingly if they drift: the hydra-node build (its script hashes) and the
 * ledger protocol parameters. A node whose hashes differ from its peers cannot
 * open a head with them, and the failure surfaces at first commit rather than
 * at connect time — so the hashes are worth showing.
 */

import { useEffect, useState } from 'react';
import { Loader2, MoreHorizontal, Pencil, RefreshCw, Server, Trash2 } from 'lucide-react';
import { toast } from 'react-toastify';
import { useResync } from '@/lib/hooks/useResync';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useAppContext } from '@/lib/contexts/AppContext';
import { cn } from '@/lib/utils';
import { ConnectHydraNodeDialog } from '@/components/hydra/ConnectHydraNodeDialog';
import { HydraNodeDetailsDialog } from '@/components/hydra/HydraNodeDetailsDialog';
import {
  checkHydraHost,
  disconnectHydraHost,
  updateHydraHost,
  useHydraHosts,
  type HydraHost,
  type HydraHostStatus,
} from '@/lib/hooks/useHydraHosts';

const STATUS_STYLES: Record<HydraHostStatus, string> = {
  Active: 'border-green-200 text-green-700 dark:border-green-900/60 dark:text-green-400',
  Draining: 'border-amber-200 text-amber-700 dark:border-amber-900/60 dark:text-amber-400',
  Disabled: 'border-muted text-muted-foreground',
  Unreachable: 'border-red-200 text-red-700 dark:border-red-900/60 dark:text-red-400',
};

const STATUS_HINTS: Record<HydraHostStatus, string> = {
  Active: 'Takes new heads.',
  Draining: 'Keeps its heads running, takes no new ones.',
  Disabled: 'Not in use.',
  Unreachable: 'Last check failed. Its heads are untouched.',
};

function shortHash(value: string | null): string {
  if (!value) return '—';
  const bare = value.replace(/^sha256:/, '');
  return `${bare.slice(0, 10)}…`;
}

function formatWhen(value: string | null): string {
  if (!value) return 'never';
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? 'never' : at.toLocaleString();
}

export function HydraNodesCard({
  onConnectedCountChange,
  variant = 'card',
}: {
  onConnectedCountChange?: (count: number) => void;
  /** 'embedded' drops the outer chrome, for a dialog that already has a header. */
  variant?: 'card' | 'embedded';
}) {
  const { apiClient, network } = useAppContext();
  const resync = useResync();
  const cardanoNetwork = network === 'Preprod' || network === 'Mainnet' ? network : undefined;
  const { hosts, isLoading, isFetching, refetch } = useHydraHosts(cardanoNetwork);

  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editing, setEditing] = useState<HydraHost | null>(null);
  const [pendingDisconnect, setPendingDisconnect] = useState<HydraHost | null>(null);
  const [detailsHost, setDetailsHost] = useState<HydraHost | null>(null);

  useEffect(() => {
    onConnectedCountChange?.(hosts.length);
  }, [hosts.length, onConnectedCountChange]);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function run(id: string, action: () => Promise<unknown>) {
    setBusyId(id);
    try {
      await action();
      await resync('hydra');
      await refetch();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The action failed');
    } finally {
      setBusyId(null);
    }
  }

  async function handleCheck(host: HydraHost) {
    await run(host.id, async () => {
      const checked = await checkHydraHost(apiClient, host.id);
      if (checked.status === 'Unreachable') {
        toast.error(checked.lastHealthError ?? `${host.name} could not be reached`);
      } else {
        toast.success(`${host.name} is ${checked.status.toLowerCase()}`);
      }
    });
  }

  async function handleToggleDraining(host: HydraHost) {
    const next: HydraHostStatus = host.status === 'Draining' ? 'Active' : 'Draining';
    await run(host.id, async () => {
      await updateHydraHost(apiClient, { id: host.id, status: next });
      toast.success(next === 'Draining' ? `${host.name} is draining` : `${host.name} is active`);
    });
  }

  async function handleDisconnect() {
    const host = pendingDisconnect;
    if (!host) return;
    setPendingDisconnect(null);
    await run(host.id, async () => {
      await disconnectHydraHost(apiClient, host.id);
      toast.success(`Disconnected ${host.name}`);
    });
  }

  const isEmbedded = variant === 'card' ? false : true;

  return (
    <div className={cn(!isEmbedded && 'rounded-lg border bg-card')}>
      <div
        className={cn(
          'flex items-start justify-between gap-4',
          isEmbedded ? 'pb-2' : 'border-b px-4 py-3',
        )}
      >
        {isEmbedded ? (
          <span />
        ) : (
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Server className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold">Connected nodes</h2>
              <Badge variant="outline">{hosts.length}</Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              Each node runs one process per head and makes that head’s keys itself.
            </p>
          </div>
        )}
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={() => void refetch()}
            disabled={isFetching}
            aria-label="Refresh connected nodes"
          >
            <RefreshCw className={cn('h-4 w-4', isFetching && 'animate-spin')} />
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-2 p-4">
          <div className="h-14 animate-pulse rounded-md bg-muted" />
          <div className="h-14 animate-pulse rounded-md bg-muted" />
        </div>
      ) : hosts.length === 0 ? (
        <div className="rounded-md border border-dashed px-4 py-8 text-center">
          <p className="text-sm text-muted-foreground">No nodes connected yet.</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Connect one with its URL and keys. Heads run on it, not here.
          </p>
        </div>
      ) : (
        <ul className={cn('divide-y', isEmbedded && 'rounded-md border')}>
          {hosts.map((host) => (
            <li
              key={host.id}
              className="flex flex-wrap items-start justify-between gap-4 px-4 py-3"
            >
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="text-sm font-medium underline-offset-4 hover:underline"
                    onClick={() => setDetailsHost(host)}
                  >
                    {host.name}
                  </button>
                  <Badge variant="outline" className={STATUS_STYLES[host.status]}>
                    {host.status}
                  </Badge>
                  <Badge variant="outline">{host.network}</Badge>
                  {!host.hasAdminToken && (
                    <Badge
                      variant="outline"
                      className="border-amber-200 text-amber-700 dark:border-amber-900/60 dark:text-amber-400"
                      title="No admin key stored: it keeps its heads running but cannot start a new one."
                    >
                      Runtime only
                    </Badge>
                  )}
                </div>
                <p className="truncate text-xs text-muted-foreground">
                  {host.baseUrl} · peers dial {host.publicPeerHost}
                </p>
                <p className="text-xs text-muted-foreground">
                  {STATUS_HINTS[host.status]} Checked {formatWhen(host.lastHealthAt)}.
                </p>
                {host.lastHealthError && (
                  <p className="text-xs text-red-600 dark:text-red-400">{host.lastHealthError}</p>
                )}
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span>hydra {host.hydraVersion?.split('-')[0] ?? '—'}</span>
                  <span title={host.scriptCatalogueHash ?? undefined}>
                    scripts {shortHash(host.scriptCatalogueHash)}
                  </span>
                  <span title={host.ledgerParamsHash ?? undefined}>
                    ledger {shortHash(host.ledgerParamsHash)}
                  </span>
                  <span>
                    {host.participantCount} head{host.participantCount === 1 ? '' : 's'}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-1">
                {busyId === host.id && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setDetailsHost(host)}
                  disabled={busyId === host.id}
                >
                  Details
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void handleCheck(host)}
                  disabled={busyId === host.id}
                >
                  Check
                </Button>
                {/* Everything that changes or removes the node lives behind the
                    menu; Details and Check are safe and used constantly. */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      disabled={busyId === host.id}
                      aria-label={`More actions for ${host.name}`}
                    >
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => void handleToggleDraining(host)}>
                      {host.status === 'Draining'
                        ? 'Take new heads again'
                        : 'Stop taking new heads'}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => {
                        setEditing(host);
                        setIsDialogOpen(true);
                      }}
                    >
                      <Pencil className="h-4 w-4" />
                      Edit or replace keys
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="text-red-600 focus:text-red-600 dark:text-red-400 dark:focus:text-red-400"
                      onClick={() => setPendingDisconnect(host)}
                    >
                      <Trash2 className="h-4 w-4" />
                      Disconnect
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </li>
          ))}
        </ul>
      )}

      <HydraNodeDetailsDialog
        host={detailsHost}
        open={detailsHost !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setDetailsHost(null);
        }}
      />
      <ConnectHydraNodeDialog
        open={isDialogOpen}
        onOpenChange={setIsDialogOpen}
        onConnected={() => void refetch()}
        host={editing}
      />
      <ConfirmDialog
        open={Boolean(pendingDisconnect)}
        onClose={() => setPendingDisconnect(null)}
        title={`Disconnect ${pendingDisconnect?.name ?? 'this node'}?`}
        description={
          pendingDisconnect && pendingDisconnect.participantCount > 0
            ? `${pendingDisconnect.participantCount} head(s) still run here. A head cannot be moved to another node, so disconnecting puts them out of reach. Drain this node and settle them first.`
            : 'This service forgets the node and its stored keys. The node itself keeps running.'
        }
        onConfirm={() => void handleDisconnect()}
      />
    </div>
  );
}
