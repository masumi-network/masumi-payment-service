/**
 * The four things an operator can do to a head, and when each is offered.
 *
 * One place decides whether an action is available and says why it is not: the
 * table's menu and the details dialog both render from these configs, and when
 * they each decided for themselves the same head could offer Close in one and
 * refuse it in the other.
 */

import {
  AlertTriangle,
  Flag,
  Info,
  Loader2,
  MoreHorizontal,
  Play,
  Upload,
  XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn, shortenAddress } from '@/lib/utils';
import { useHydraHeadReadiness, type HydraHead } from '@/lib/hooks/useHydraHeads';

export type HydraLifecycleAction = 'init' | 'commit' | 'close' | 'fanout';

export type HydraLifecycleButtonConfig = {
  action: HydraLifecycleAction;
  label: string;
  disabledReason?: string;
};

export type PendingLifecycleAction = {
  head: HydraHead;
  action: HydraLifecycleAction;
};
export const lifecycleActions: Array<Omit<HydraLifecycleButtonConfig, 'disabledReason'>> = [
  // Named by what they do to the head, not by the protocol message they send.
  // "Init" and "Fanout" are hydra-node vocabulary; an operator deciding whether
  // to press one is thinking about opening, funding and settling.
  { action: 'init', label: 'Open head' },
  { action: 'commit', label: 'Fund at open' },
  { action: 'close', label: 'Close head' },
  { action: 'fanout', label: 'Settle on chain' },
];

/**
 * Actions that need this node to be answering and caught up.
 *
 * All four post something the node must build or observe, so all four are
 * gated. The API refuses them anyway; offering them regardless meant the
 * operator learned the node's state from a failed action instead of from the
 * control, having already been told in the panel directly above.
 */
export function getLifecycleActionDisabledReason(
  head: HydraHead,
  action: HydraLifecycleAction,
  readiness?: { isReady: boolean; reason: string | null } | null,
) {
  // Stage first, readiness second. A finished head has no action left to take,
  // and its node is stopped — so asking about readiness first answered every
  // action with "the node is not running", and a correctly settled head read as
  // four things to go and fix rather than as one thing that is done.
  const stageReason = getStageDisabledReason(head, action);
  if (stageReason !== undefined) return stageReason;
  if (readiness != null && !readiness.isReady) {
    return readiness.reason ?? 'The node is not ready yet.';
  }
  return undefined;
}

/** Whether the head's own stage permits this action, ignoring the node. */
export function getStageDisabledReason(head: HydraHead, action: HydraLifecycleAction) {
  if (action === 'init') {
    if (!head.LocalParticipant) return 'This head has no node on your side';
    // One side opens, and it is the side that redeemed: two Inits race for the
    // same seed inputs and the loser is left waiting on a head that never
    // existed. Stated rather than hidden, so the wait looks intended.
    if (head.Invite?.role === 'Issuer')
      return 'They redeemed your invite, so they open the head. It moves on its own when they do.';
    if (head.status !== 'Idle') return `Already past this. The head is ${head.status}.`;
    return undefined;
  }

  if (action === 'commit') {
    if (!head.LocalParticipant) return 'This head has no node on your side';
    if (head.LocalParticipant.hasCommitted) return 'You have already funded this head at open';
    // The API accepts Initializing OR Open, an open head takes the same
    // deposit, which is what Add funds does. Refusing Open here forbade
    // something the service allows, and told an operator who had not yet
    // funded a head that the one control for it was gone.
    if (head.status !== 'Initializing' && head.status !== 'Open')
      return 'Only while the head is opening or open';
    return undefined;
  }

  if (action === 'close') {
    if (head.status !== 'Open') return 'Only an open head can be closed';
    return undefined;
  }

  if (head.status !== 'FanoutPossible')
    return 'Available once the head is closed and its dispute window has passed';
  return undefined;
}

export function getLifecycleButtonConfigs(
  head: HydraHead,
  readiness?: { isReady: boolean; reason: string | null } | null,
): HydraLifecycleButtonConfig[] {
  return lifecycleActions.map((actionConfig) => ({
    ...actionConfig,
    disabledReason: getLifecycleActionDisabledReason(head, actionConfig.action, readiness),
  }));
}

/**
 * The one cause behind every greyed action, when there is one.
 *
 * A node that is down or behind blocks all four, and repeating the same
 * sentence under each reads as four separate problems — the operator counts
 * four failures and goes looking for four fixes. Stated once, above the menu,
 * it reads as what it is: one condition, and nothing here works until it is
 * cleared. Stage gating ("only an open head can be closed") is per action and
 * stays with its action, because those genuinely differ.
 */
export function findSharedBlocker(configs: HydraLifecycleButtonConfig[]): string | null {
  const reasons = configs.map((config) => config.disabledReason);
  if (reasons.some((reason) => reason === undefined)) return null;
  const distinct = new Set(reasons);
  return distinct.size === 1 ? (reasons[0] ?? null) : null;
}

export function LifecycleActionIcon({
  action,
  isRunning,
}: {
  action: HydraLifecycleAction;
  isRunning: boolean;
}) {
  if (isRunning) {
    return <Loader2 className="h-4 w-4 animate-spin" />;
  }

  if (action === 'init') return <Play className="h-4 w-4" />;
  if (action === 'commit') return <Upload className="h-4 w-4" />;
  if (action === 'close') return <XCircle className="h-4 w-4" />;
  return <Flag className="h-4 w-4" />;
}

export function getLifecycleActionConfirmCopy(head: HydraHead, action: HydraLifecycleAction) {
  const headLabel = head.headIdentifier
    ? shortenAddress(head.headIdentifier, 10)
    : shortenAddress(head.id, 10);

  if (action === 'init') {
    return {
      title: 'Confirm head init',
      description: `Initialize Hydra head ${headLabel}. This submits the opening transaction through the configured local Hydra node.`,
    };
  }

  if (action === 'commit') {
    return {
      title: 'Confirm local commit',
      description: `Commit the local participant funds into Hydra head ${headLabel}. This submits an L1 commit transaction.`,
    };
  }

  if (action === 'close') {
    return {
      title: 'Confirm head close',
      description: `Close Hydra head ${headLabel}. This starts the close flow and stops new in-head transactions.`,
    };
  }

  return {
    title: 'Confirm head fanout',
    description: `Fan out Hydra head ${headLabel}. This finalizes the head on L1 with the latest available state.`,
  };
}

export function HydraLifecycleActionMenu({
  head,
  isRunning,
  onRequestLifecycle,
}: {
  head: HydraHead;
  isRunning: boolean;
  onRequestLifecycle: (head: HydraHead, action: HydraLifecycleAction) => void;
}) {
  // Only asked for a head with a node to ask about, only while its stage still
  // permits some action, and only polled while the node is not ready. Without
  // the stage condition every settled head on screen re-asked a Host round trip
  // plus a chain read every ten seconds, for good: a finished head's node is
  // stopped, so readiness is false and the poll never turns itself off.
  const stagePermitsAnyAction = lifecycleActions.some(
    (actionConfig) => getStageDisabledReason(head, actionConfig.action) === undefined,
  );
  const { connection } = useHydraHeadReadiness(
    head.id,
    head.LocalParticipant != null && stagePermitsAnyAction,
  );
  const configs = getLifecycleButtonConfigs(head, connection);
  const sharedBlocker = findSharedBlocker(configs);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn('h-8 w-8', sharedBlocker && 'text-amber-700 dark:text-amber-400')}
          aria-label="Open Hydra head actions"
          // Carried on the trigger too, so a head whose node is down reads as
          // blocked from the table, without opening the menu to find out.
          title={sharedBlocker ?? 'Hydra head actions'}
        >
          {isRunning ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <MoreHorizontal className="h-4 w-4" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48 max-w-80">
        {/* One cause, stated once, in the colour of something to go and fix.
            The actions below stay greyed and say nothing further: repeating it
            four times turned one blocked node into four mysteries. */}
        {sharedBlocker && (
          <>
            <div className="flex items-start gap-2 px-2 py-1.5 text-xs text-amber-700 dark:text-amber-400">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{sharedBlocker}</span>
            </div>
            <DropdownMenuSeparator />
          </>
        )}
        {configs.map((config) => {
          const isDisabled = isRunning || Boolean(config.disabledReason);
          // Already said above, in one place.
          const ownReason = sharedBlocker ? undefined : config.disabledReason;

          return (
            <DropdownMenuItem
              key={config.action}
              disabled={isDisabled}
              // No preventDefault: the menu should close on choosing an action.
              // Each one opens its own confirmation, so holding the menu open
              // just leaves it hanging behind that dialog.
              onSelect={() => onRequestLifecycle(head, config.action)}
              className={cn(ownReason && 'flex-col items-start gap-0.5')}
            >
              <span className="flex items-center gap-2">
                <LifecycleActionIcon action={config.action} isRunning={isRunning} />
                <span>{config.label}</span>
              </span>
              {/* Spelled out rather than left to a tooltip. Hydra gates each
                  action to one stage, so most of this menu is greyed most of
                  the time, and hover text on a disabled item is easy to miss,
                  which makes a correctly-gated menu look broken. */}
              {ownReason && (
                <span className="flex items-start gap-1.5 pl-6 text-xs font-normal text-muted-foreground">
                  <Info className="mt-0.5 h-3 w-3 shrink-0" />
                  <span>{ownReason}</span>
                </span>
              )}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
