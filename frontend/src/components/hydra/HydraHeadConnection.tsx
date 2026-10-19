/**
 * Whether anything can be done with this head right now.
 *
 * Two things have to be true and both were invisible: the node has to be
 * running and synced, and this service has to hold a live session to it. A head
 * can be perfectly valid on chain while neither holds, and the only evidence
 * was an action failing minutes later with a gateway timeout, which says
 * nothing about which of the two was missing.
 *
 * Checked as soon as the head is opened, then again every few seconds only
 * while it is not ready and its stage still permits an action. Asking by hand
 * meant the dialog said "Not checked yet" at exactly the moment an operator
 * opened it to find out.
 */

import { formatHydraNodeState } from '@/lib/display-labels';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { HydraNotice } from '@/components/hydra/HydraNotice';
import { useHydraHeadReadiness } from '@/lib/hooks/useHydraHeads';
import { NodeConnectionHint } from '@/components/hydra/hydra-hints';
import { cn } from '@/lib/utils';

type Tone = 'ok' | 'warn' | 'unknown';

const DOT_TONE: Record<Tone, string> = {
  ok: 'bg-green-500',
  warn: 'bg-amber-500',
  unknown: 'bg-muted-foreground/40',
};

function StatusItem({ label, value, tone }: { label: string; value: string; tone: Tone }) {
  return (
    <div className="min-w-0 space-y-0.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="flex items-center gap-1.5 text-sm font-medium">
        <span className={cn('h-2 w-2 shrink-0 rounded-full', DOT_TONE[tone])} aria-hidden />
        <span className="truncate">{value}</span>
      </p>
    </div>
  );
}

export function HydraHeadConnectionPanel({
  headId,
  poll,
}: {
  headId: string;
  /** False once the head's stage permits no action: its node stays down. */
  poll: boolean;
}) {
  const {
    connection: state,
    isFetching,
    isError,
    refetch,
  } = useHydraHeadReadiness(headId, true, poll);

  const isHealthy = state !== null && state.connected && state.isReady;

  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-medium">
          Connection
          <NodeConnectionHint />
          {state !== null && (
            <span
              className={cn(
                'ml-1 text-xs font-normal',
                isHealthy
                  ? 'text-green-600 dark:text-green-400'
                  : 'text-amber-600 dark:text-amber-400',
              )}
            >
              {isHealthy ? 'Ready' : 'Not ready'}
            </span>
          )}
        </h3>
        <div className="flex items-center gap-1">
          {state !== null && (
            <span className="text-xs text-muted-foreground">
              {new Date(state.checkedAt).toLocaleTimeString()}
            </span>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label="Check the connection again"
            onClick={() => void refetch()}
            disabled={isFetching}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', isFetching && 'animate-spin')} />
          </Button>
        </div>
      </div>

      {state === null ? (
        <p className="text-sm text-muted-foreground">
          {isError ? 'Could not check the connection.' : 'Checking…'}
        </p>
      ) : (
        <div className="space-y-3">
          {/* Reported separately because they fail independently and are fixed
              differently: a node that is down needs starting, a session that is
              absent usually re-establishes on its own. The counterparty reading
              says their node is up and in the cluster, not that it is synced. */}
          <div className="grid grid-cols-3 gap-3">
            <StatusItem
              label="Node"
              value={formatHydraNodeState(state.nodeState)}
              tone={state.nodeState === 'Unknown' ? 'unknown' : state.isReady ? 'ok' : 'warn'}
            />
            <StatusItem
              label="Session"
              value={state.connected ? 'Connected' : 'Not connected'}
              tone={state.connected ? 'ok' : 'warn'}
            />
            <StatusItem
              label="Counterparty"
              value={
                state.peerConnected === true
                  ? 'Reachable'
                  : state.peerConnected === false
                    ? 'Not reachable'
                    : 'Unknown'
              }
              tone={
                state.peerConnected === true
                  ? 'ok'
                  : state.peerConnected === false
                    ? 'warn'
                    : 'unknown'
              }
            />
          </div>
          {state.reason !== null && (
            <HydraNotice tone="warn">
              <p>{state.reason}</p>
            </HydraNotice>
          )}
          {state.reason === null && !state.connected && (
            <p className="text-xs text-muted-foreground">
              The node is fine, this service just has not connected to it yet. It retries every
              minute or so. If it is still not connected after that, the head&apos;s errors say why.
            </p>
          )}
          {state.peerConnected === false && (
            <p className="text-xs text-muted-foreground">
              Their node is not in the cluster right now. Opening the head still works, but it will
              sit in Initializing until their node is back and posts its commit.
            </p>
          )}
          {/* A head's ledger is frozen when it opens and does not follow the
              chain afterwards. Settlement is an L1 transaction, and value
              cannot be added to an output on its way out, so a chain that
              moves can leave this head holding outputs L1 will refuse to take
              back — with no way to fix them from inside. Shown here because
              the decision it drives is about THIS head: settle it before the
              gap grows. */}
          {(state.paramDrift?.length ?? 0) > 0 && (
            <HydraNotice tone={state.paramDrift?.some((d) => d.blocksFanout) ? 'warn' : 'info'}>
              <p>
                {state.paramDrift?.some((d) => d.blocksFanout)
                  ? 'The chain has changed since this head opened, in a way that can stop it being settled. Close it soon rather than adding to it.'
                  : 'The chain has changed since this head opened. Nothing is stranded, but this head is now stricter than the chain and will refuse funds the chain accepts.'}
              </p>
              <ul className="mt-1 space-y-0.5">
                {state.paramDrift?.map((entry) => (
                  <li key={entry.parameter} className="font-mono text-xs">
                    {entry.parameter}: head {entry.head}, chain {entry.chain}
                  </li>
                ))}
              </ul>
            </HydraNotice>
          )}
          {/* A head can be open, synced and peered while this side still cannot
              do anything in it. Requests are accepted and then retried quietly
              forever, so without this the operator sees work that stays pending
              against a head that reports itself healthy. */}
          {state.l2Blocked && <HydraNotice tone="warn">{state.l2Blocked}</HydraNotice>}
        </div>
      )}
    </div>
  );
}
