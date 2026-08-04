/**
 * Whether anything can be done with this head right now.
 *
 * Two things have to be true and both were invisible: the node has to be
 * running and synced, and this service has to hold a live session to it. A head
 * can be perfectly valid on chain while neither holds — and the only evidence
 * was an action failing minutes later with a gateway timeout, which says
 * nothing about which of the two was missing.
 *
 * Checked on demand rather than polled. It costs a round trip to the Host, and
 * an operator asks it at one specific moment: when something looks stuck.
 */

import { useState } from 'react';
import { CheckCircle2, Loader2, RefreshCw, XCircle } from 'lucide-react';
import { toast } from 'react-toastify';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { HydraNotice } from '@/components/hydra/HydraNotice';
import { useAppContext } from '@/lib/contexts/AppContext';
import { readHydraHeadConnection, type HydraHeadConnection } from '@/lib/hooks/useHydraHeads';
import { NodeConnectionHint } from '@/components/hydra/hydra-hints';

export function HydraHeadConnectionPanel({ headId }: { headId: string }) {
  const { apiClient } = useAppContext();
  const [state, setState] = useState<HydraHeadConnection | null>(null);
  const [isChecking, setIsChecking] = useState(false);

  async function handleCheck() {
    setIsChecking(true);
    try {
      setState(await readHydraHeadConnection(apiClient, { headId }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to check the connection');
    } finally {
      setIsChecking(false);
    }
  }

  const isHealthy = state !== null && state.connected && state.isReady;

  return (
    <div className="space-y-2 rounded-md border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="flex items-center gap-1.5 font-medium">
            Connection
            <NodeConnectionHint />
          </h3>
          {state !== null &&
            (isHealthy ? (
              <Badge variant="outline" className="text-green-600 dark:text-green-400">
                <CheckCircle2 className="mr-1 h-3 w-3" />
                Ready
              </Badge>
            ) : (
              <Badge variant="outline" className="text-amber-600 dark:text-amber-400">
                <XCircle className="mr-1 h-3 w-3" />
                Not ready
              </Badge>
            ))}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void handleCheck()}
          disabled={isChecking}
        >
          {isChecking ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
          Check
        </Button>
      </div>

      {state === null ? (
        <p className="text-sm text-muted-foreground">Not checked yet.</p>
      ) : (
        <div className="space-y-1.5">
          {/* Reported separately because they fail independently and are fixed
              differently: a node that is down needs starting, a session that is
              absent usually re-establishes on its own. */}
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Node</span>
            <span>{state.nodeState}</span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Live session</span>
            <span>{state.connected ? 'Connected' : 'Not connected'}</span>
          </div>
          {/* The only evidence available about the other side. Worth showing, and
              worth not overstating: it says their node is up and in the cluster,
              not that it has finished syncing the chain. */}
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Counterparty node</span>
            <span>
              {state.peerConnected === true
                ? 'Reachable'
                : state.peerConnected === false
                  ? 'Not reachable'
                  : 'Not reported yet'}
            </span>
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
          <p className="text-xs text-muted-foreground">
            Checked {new Date(state.checkedAt).toLocaleTimeString()}.
          </p>
        </div>
      )}
    </div>
  );
}
