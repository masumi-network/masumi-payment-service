/**
 * Release and maintenance for one Hydra node: which release it runs, whether a
 * newer one exists, and the pause that an upgrade starts with.
 *
 * The pause is the server's: it refuses new work, waits for in-flight work,
 * then stops the node's head processes, and it keeps going with this dialog
 * closed. This only shows the phase and sends Pause and Resume.
 */

import { useEffect, useState } from 'react';
import { ExternalLink, Loader2, PauseCircle, PlayCircle } from 'lucide-react';
import { toast } from 'react-toastify';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { HydraNotice } from '@/components/hydra/HydraNotice';
import { useAppContext } from '@/lib/contexts/AppContext';
import { useResync } from '@/lib/hooks/useResync';
import { useReleaseStatus } from '@/lib/hooks/useReleaseStatus';
import {
  pauseHydraHost,
  resumeHydraHost,
  useHydraHostPause,
  type HydraHostPauseState,
} from '@/lib/hooks/useHydraHostPause';
import type { HydraHost } from '@/lib/hooks/useHydraHosts';
import { formatRelease, UPGRADE_GUIDE_URL } from '@/lib/release';

const TICK_MS = 1000;
/** The node may fall this far behind the chain before it stops transacting. */
const PAUSE_TARGET_MINUTES = 30;

const PHASE_TEXT: Record<HydraHostPauseState['phase'], string> = {
  Active: 'Running',
  Draining: 'Pausing: waiting for work in flight',
  Stopping: 'Pausing: stopping head processes',
  Paused: 'Paused',
};

function useElapsedMinutes(since: string | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [since]);
  return since === null ? null : Math.max(0, Math.floor((now - Date.parse(since)) / 60_000));
}

function inFlightText(state: HydraHostPauseState): string {
  const { l2Transactions, topups, withdrawals } = state.inFlight;
  const parts = [
    l2Transactions > 0
      ? `${l2Transactions} L2 transaction${l2Transactions === 1 ? '' : 's'}`
      : null,
    topups > 0 ? `${topups} top-up${topups === 1 ? '' : 's'}` : null,
    withdrawals > 0 ? `${withdrawals} withdrawal${withdrawals === 1 ? '' : 's'}` : null,
  ].filter((part) => part !== null);
  return parts.length === 0 ? 'Nothing in flight.' : `Waiting for ${parts.join(', ')}.`;
}

export function HydraHostMaintenance({ host }: { host: HydraHost }) {
  const { apiClient } = useAppContext();
  const resync = useResync();
  const { releaseStatus } = useReleaseStatus();
  const { pauseState } = useHydraHostPause(host.id);
  const [confirming, setConfirming] = useState<'pause' | 'force' | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const phase = pauseState?.phase ?? (host.pausedAt === null ? 'Active' : 'Draining');
  const pausedAt = pauseState?.pausedAt ?? host.pausedAt;
  const elapsed = useElapsedMinutes(pausedAt);
  const running = formatRelease(host.release) ?? 'not reported';
  const updateAvailable = releaseStatus?.hosts.find((entry) => entry.id === host.id)?.release
    .updateAvailable;
  const latest = releaseStatus?.latest?.version ?? 'not checked';

  async function run(action: () => Promise<HydraHostPauseState>, done: string) {
    setIsBusy(true);
    try {
      await action();
      toast.success(done);
      await resync('hydra');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The request failed');
    } finally {
      setIsBusy(false);
      setConfirming(null);
    }
  }

  return (
    <section className="space-y-2 rounded-md border px-4 py-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">Release</span>
        <span className="font-mono">{running}</span>
        <span className="text-muted-foreground">· latest {latest}</span>
        {updateAvailable === true && (
          <a href={UPGRADE_GUIDE_URL} target="_blank" rel="noreferrer">
            <Badge variant="outline" className="gap-1 border-amber-500 text-amber-600">
              Update available
              <ExternalLink className="h-3 w-3" />
            </Badge>
          </a>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{PHASE_TEXT[phase]}</Badge>
        {elapsed !== null && (
          <span className="text-xs text-muted-foreground">for {elapsed} min</span>
        )}
        <div className="ml-auto flex gap-2">
          {phase === 'Active' ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={isBusy || !host.hasAdminToken}
              onClick={() => setConfirming('pause')}
            >
              <PauseCircle className="h-4 w-4" />
              Pause for maintenance
            </Button>
          ) : (
            <>
              {phase === 'Draining' && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={isBusy}
                  onClick={() => setConfirming('force')}
                >
                  Pause now
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={isBusy}
                onClick={() =>
                  void run(() => resumeHydraHost(apiClient, host.id), `${host.name} resumed`)
                }
              >
                {isBusy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <PlayCircle className="h-4 w-4" />
                )}
                Resume
              </Button>
            </>
          )}
        </div>
      </div>

      {phase === 'Draining' && pauseState && (
        <p className="text-xs text-muted-foreground">{inFlightText(pauseState)}</p>
      )}
      {phase === 'Stopping' &&
        pauseState?.nodes
          .filter((node) => node.state !== 'Stopped')
          .map((node) => (
            <p key={node.nodeId} className="text-xs text-muted-foreground">
              Head process <span className="font-mono">{node.nodeId}</span>:{' '}
              {node.error ?? `not stopped yet (${node.state ?? 'state unknown'})`}
            </p>
          ))}
      {phase !== 'Active' && (
        <HydraNotice tone={elapsed !== null && elapsed >= PAUSE_TARGET_MINUTES ? 'warn' : 'info'}>
          <p>
            No new work starts on this node&apos;s heads. Stopped head processes cannot contest a
            close, so keep the pause short and resume within {PAUSE_TARGET_MINUTES} minutes.
          </p>
        </HydraNotice>
      )}
      {!host.hasAdminToken && phase === 'Active' && (
        <p className="text-xs text-muted-foreground">
          Pausing needs the admin key. Add it from Edit connection.
        </p>
      )}

      <ConfirmDialog
        elevatedChildStack
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        title={confirming === 'force' ? 'Stop the head processes now?' : `Pause ${host.name}?`}
        confirmLabel={confirming === 'force' ? 'Pause now' : 'Pause'}
        isLoading={isBusy}
        description={
          confirming === 'force'
            ? 'The head processes stop without waiting for work in flight. That work continues after Resume.'
            : 'New work on this node stops at once. When the work in flight is done, the head processes stop. Use this before an upgrade, then Resume.'
        }
        onConfirm={() =>
          void run(
            () => pauseHydraHost(apiClient, host.id, confirming === 'force'),
            `${host.name} is pausing`,
          )
        }
      />
    </section>
  );
}
