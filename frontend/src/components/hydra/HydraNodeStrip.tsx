/**
 * The nodes, and the heads that run on them.
 *
 * A head is not a free-floating object: it runs on exactly one node, for its
 * whole life, and cannot be moved. Hiding the nodes behind a dialog lost that —
 * the table listed heads with no sense of where they were, and adding a second
 * node had nowhere to live.
 *
 * So the nodes come back as a strip, one chip each, carrying the two facts an
 * operator reads at a glance: is it healthy, and how many heads is it running.
 * Selecting one filters the table to its heads, which is the "head inside the
 * node" view without a second layout.
 *
 * Deliberately not the old card: that repeated every node's URL, version,
 * script hash and check time in the primary flow. Those belong in the node's
 * own details, one click away.
 */

import { Plus, Server } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { HydraHost } from '@/lib/hooks/useHydraHosts';

const DOT: Record<string, string> = {
  Active: 'bg-green-500',
  Draining: 'bg-amber-500',
  Unreachable: 'bg-red-500',
  Disabled: 'bg-muted-foreground',
};

export type HydraNodeStripProps = {
  hosts: HydraHost[];
  /** Heads per host id, so a chip can say what it is carrying. */
  headCounts: Record<string, number>;
  selectedHostId: string | null;
  onSelectHost: (hostId: string | null) => void;
  onOpenHost: (host: HydraHost) => void;
  onAddNode: () => void;
};

export function HydraNodeStrip({
  hosts,
  headCounts,
  selectedHostId,
  onSelectHost,
  onOpenHost,
  onAddNode,
}: HydraNodeStripProps) {
  if (hosts.length === 0) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed px-4 py-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Server className="h-4 w-4" />
          No Hydra node connected yet — a head has to run somewhere.
        </div>
        <Button type="button" size="sm" onClick={onAddNode}>
          <Plus className="h-4 w-4" />
          Connect node
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {hosts.map((host) => {
        const isSelected = selectedHostId === host.id;
        const heads = headCounts[host.id] ?? 0;

        return (
          <div
            key={host.id}
            className={cn(
              'flex items-center gap-1 rounded-lg border bg-card pl-3 pr-1 transition-colors',
              isSelected ? 'border-foreground/40 bg-accent' : 'hover:bg-accent/50',
            )}
          >
            {/* The chip filters; its name opens the node. Two verbs, so neither
                has to be guessed from one target. */}
            <button
              type="button"
              onClick={() => onSelectHost(isSelected ? null : host.id)}
              aria-pressed={isSelected}
              className="flex items-center gap-2 py-2 text-left focus-visible:outline-hidden"
            >
              <span
                aria-hidden
                className={cn('h-2 w-2 shrink-0 rounded-full', DOT[host.status] ?? 'bg-muted')}
              />
              <span className="text-sm font-medium">{host.name}</span>
              <span className="text-xs text-muted-foreground">
                {heads} {heads === 1 ? 'head' : 'heads'}
              </span>
            </button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-muted-foreground"
              onClick={() => onOpenHost(host)}
            >
              Details
            </Button>
          </div>
        );
      })}

      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onAddNode}
        className="border-dashed"
      >
        <Plus className="h-4 w-4" />
        Add node
      </Button>

      {selectedHostId !== null && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-xs text-muted-foreground"
          onClick={() => onSelectHost(null)}
        >
          Show all heads
        </Button>
      )}
    </div>
  );
}
