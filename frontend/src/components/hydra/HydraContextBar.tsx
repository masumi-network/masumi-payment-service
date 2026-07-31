/**
 * One line of context above the heads table.
 *
 * The page has three objects — nodes, invites, heads — and previously gave each
 * a full-width card, so the table an operator actually came for sat below four
 * stacked blocks and off the bottom of the screen. Every other page in this
 * admin reaches its table in one screen; this brings Hydra in line.
 *
 * Nodes and invites are not less important, they are less *frequent*: you
 * connect a node once and issue an invite occasionally, but you read the heads
 * table every time. So they keep their counts here, in a strip that is also the
 * way in to managing them, and their detail moves behind a click.
 */

import type { ReactNode } from 'react';
import { Boxes, Server, Ticket } from 'lucide-react';
import { cn } from '@/lib/utils';

type Stat = {
  icon: ReactNode;
  label: string;
  value: number;
  /** Rendered as a button when set, so the whole item is the affordance. */
  onClick?: () => void;
  /** Muted when there is nothing to look at. */
  isEmpty?: boolean;
  emphasis?: 'default' | 'positive';
};

function StatItem({ icon, label, value, onClick, isEmpty, emphasis = 'default' }: Stat) {
  const body = (
    <>
      <span
        className={cn(
          'flex h-7 w-7 items-center justify-center rounded-md border bg-background/60 text-muted-foreground',
          emphasis === 'positive' &&
            !isEmpty &&
            'border-green-500/40 text-green-600 dark:text-green-400',
        )}
      >
        {icon}
      </span>
      <span className="flex flex-col leading-tight">
        <span
          className={cn('text-base font-semibold tabular-nums', isEmpty && 'text-muted-foreground')}
        >
          {value}
        </span>
        <span className="text-xs text-muted-foreground">{label}</span>
      </span>
    </>
  );

  if (!onClick) {
    return <div className="flex items-center gap-2.5 px-3 py-2">{body}</div>;
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-2.5 rounded-md px-3 py-2 text-left transition-colors hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
    >
      {body}
    </button>
  );
}

export type HydraContextBarProps = {
  nodeCount: number;
  inviteCount: number;
  openHeads: number;
  activeHeads: number;
  onManageNodes: () => void;
  onManageInvites: () => void;
};

export function HydraContextBar({
  nodeCount,
  inviteCount,
  openHeads,
  activeHeads,
  onManageNodes,
  onManageInvites,
}: HydraContextBarProps) {
  return (
    <div className="flex flex-wrap items-center gap-1 rounded-lg border bg-card p-1">
      <StatItem
        icon={<Server className="h-3.5 w-3.5" />}
        label={nodeCount === 1 ? 'connected node' : 'connected nodes'}
        value={nodeCount}
        isEmpty={nodeCount === 0}
        onClick={onManageNodes}
      />
      <span aria-hidden className="h-8 w-px bg-border" />
      <StatItem
        icon={<Ticket className="h-3.5 w-3.5" />}
        label={inviteCount === 1 ? 'invite' : 'invites'}
        value={inviteCount}
        isEmpty={inviteCount === 0}
        onClick={onManageInvites}
      />
      <span aria-hidden className="h-8 w-px bg-border" />
      <StatItem
        icon={<Boxes className="h-3.5 w-3.5" />}
        label="open"
        value={openHeads}
        isEmpty={openHeads === 0}
        emphasis="positive"
      />
      <StatItem
        icon={<Boxes className="h-3.5 w-3.5" />}
        label="in lifecycle"
        value={activeHeads}
        isEmpty={activeHeads === 0}
      />
    </div>
  );
}
