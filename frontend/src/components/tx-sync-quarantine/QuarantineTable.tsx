import { useState, useSyncExternalStore } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { EmptyState } from '@/components/ui/empty-state';
import { cn } from '@/lib/utils';
import { formatDateTime } from '@/lib/format-date';
import type { QuarantineEntry } from '@/lib/hooks/useTxSyncQuarantine';

interface QuarantineTableProps {
  entries: QuarantineEntry[];
  isLoading: boolean;
  onRetry: (entry: QuarantineEntry) => void;
  onDelete: (entry: QuarantineEntry) => void;
  /** Id of the entry whose retry is in flight, if any. */
  retryingId: string | null;
  emptyTitle: string;
  emptyDescription: string;
}

const REASON_LABELS: Record<QuarantineEntry['reason'], string> = {
  ExtendedLookupFailed: 'Lookup failed',
  ProcessingFailed: 'Processing failed',
};

/** Compact elapsed time, e.g. `4m`, `3h`, `2d`. */
function formatElapsed(fromMs: number, toMs: number): string {
  const seconds = Math.max(0, Math.round((toMs - fromMs) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function formatNextRetry(nextRetryAt: Date, nowMs: number): string {
  const dueMs = new Date(nextRetryAt).getTime();
  if (Number.isNaN(dueMs)) return '—';
  return dueMs <= nowMs ? 'Due now' : `in ${formatElapsed(nowMs, dueMs)}`;
}

// Ages and retry countdowns need a clock, which is not something a component may
// read during render. It lives here as an external store instead: one interval
// for the whole table, ticking every 30s so "Due now" arrives on its own.
const clockListeners = new Set<() => void>();
let clockNowMs = 0;
let clockInterval: ReturnType<typeof setInterval> | null = null;

function subscribeClock(listener: () => void) {
  clockListeners.add(listener);
  if (clockInterval === null) {
    clockNowMs = Date.now();
    clockInterval = setInterval(() => {
      clockNowMs = Date.now();
      clockListeners.forEach((notify) => notify());
    }, 30000);
  }

  return () => {
    clockListeners.delete(listener);
    if (clockListeners.size === 0 && clockInterval !== null) {
      clearInterval(clockInterval);
      clockInterval = null;
    }
  };
}

/** 0 until the store is subscribed (and on the server), which renders as `—`. */
const getClockSnapshot = () => clockNowMs;
const getClockServerSnapshot = () => 0;

function statusBadge(entry: QuarantineEntry) {
  if (entry.resolvedAt != null) {
    return <Badge variant="success">Resolved</Badge>;
  }
  if (entry.needsOperator) {
    return <Badge variant="destructive">Needs operator</Badge>;
  }
  return <Badge variant="warning">Pending</Badge>;
}

export function QuarantineTable({
  entries,
  isLoading,
  onRetry,
  onDelete,
  retryingId,
  emptyTitle,
  emptyDescription,
}: QuarantineTableProps) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const nowMs = useSyncExternalStore(subscribeClock, getClockSnapshot, getClockServerSnapshot);

  const toggleExpanded = (id: string) =>
    setExpandedIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="border rounded-lg overflow-x-auto">
      <table className={cn('w-full transition-opacity duration-150', isLoading && 'opacity-70')}>
        <thead className="bg-muted/30 dark:bg-muted/15">
          <tr className="border-b">
            <th className="p-4 pl-6 w-10" />
            <th className="p-4 text-left text-sm font-medium text-muted-foreground">
              Transaction Hash
            </th>
            <th className="p-4 text-left text-sm font-medium text-muted-foreground">Reason</th>
            <th className="p-4 text-left text-sm font-medium text-muted-foreground">Status</th>
            <th className="p-4 text-left text-sm font-medium text-muted-foreground">Attempts</th>
            <th className="p-4 text-left text-sm font-medium text-muted-foreground">Next Retry</th>
            <th className="p-4 text-left text-sm font-medium text-muted-foreground">Age</th>
            <th className="p-4 text-left text-sm font-medium text-muted-foreground">Network</th>
            <th className="p-4 pr-8 text-right text-sm font-medium text-muted-foreground">
              Actions
            </th>
          </tr>
        </thead>
        <tbody>
          {entries.length === 0 ? (
            <tr>
              <td colSpan={9}>
                <EmptyState icon="inbox" title={emptyTitle} description={emptyDescription} />
              </td>
            </tr>
          ) : (
            entries.map((entry, index) => {
              const isExpanded = expandedIds.has(entry.id);
              const isResolved = entry.resolvedAt != null;

              return [
                <tr
                  key={entry.id}
                  className={cn(
                    'border-b animate-fade-in opacity-0 transition-[background-color,opacity] duration-150',
                    entry.needsOperator && 'bg-destructive/10 border-l-2 border-l-destructive',
                  )}
                  style={{ animationDelay: `${Math.min(index, 9) * 40}ms` }}
                >
                  <td className="p-4 pl-6 w-10">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      aria-label={isExpanded ? 'Hide details' : 'Show details'}
                      aria-expanded={isExpanded}
                      onClick={() => toggleExpanded(entry.id)}
                    >
                      {isExpanded ? (
                        <ChevronDown className="h-4 w-4" />
                      ) : (
                        <ChevronRight className="h-4 w-4" />
                      )}
                    </Button>
                  </td>
                  <td className="p-4">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm text-muted-foreground">
                        {`${entry.txHash.slice(0, 8)}...${entry.txHash.slice(-8)}`}
                      </span>
                      <CopyButton value={entry.txHash} />
                    </div>
                  </td>
                  <td className="p-4 text-sm">{REASON_LABELS[entry.reason]}</td>
                  <td className="p-4">{statusBadge(entry)}</td>
                  <td className="p-4 text-sm">{entry.attempts}</td>
                  <td className="p-4 text-sm">
                    {isResolved || nowMs === 0 ? '—' : formatNextRetry(entry.nextRetryAt, nowMs)}
                  </td>
                  <td className="p-4 text-sm">
                    {nowMs === 0 ? '—' : formatElapsed(new Date(entry.createdAt).getTime(), nowMs)}
                  </td>
                  <td className="p-4 text-sm">{entry.PaymentSource.network}</td>
                  <td className="p-4 pr-8">
                    <div className="flex justify-end gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={isResolved || retryingId === entry.id}
                        title={
                          isResolved
                            ? 'Already resolved — nothing left to apply'
                            : 'Queue this transaction for an immediate retry'
                        }
                        onClick={() => onRetry(entry)}
                      >
                        {retryingId === entry.id ? 'Queueing...' : 'Retry'}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => onDelete(entry)}>
                        Delete
                      </Button>
                    </div>
                  </td>
                </tr>,
                isExpanded && (
                  <tr key={`${entry.id}-details`} className="border-b bg-muted/20">
                    <td colSpan={9} className="px-6 py-4">
                      <div className="grid gap-4 md:grid-cols-2">
                        <div className="space-y-1">
                          <h5 className="text-sm font-medium">Transaction Hash</h5>
                          <p className="text-sm font-mono break-all">{entry.txHash}</p>
                        </div>
                        <div className="space-y-1">
                          <h5 className="text-sm font-medium">Chain Position</h5>
                          <p className="text-sm">
                            {entry.blockHeight == null
                              ? 'Unknown'
                              : `Block ${entry.blockHeight}${
                                  entry.txIndex == null ? '' : `, index ${entry.txIndex}`
                                }`}
                          </p>
                        </div>
                        <div className="space-y-1">
                          <h5 className="text-sm font-medium">First Quarantined</h5>
                          <p className="text-sm">{formatDateTime(entry.createdAt)}</p>
                        </div>
                        <div className="space-y-1">
                          <h5 className="text-sm font-medium">Last Updated</h5>
                          <p className="text-sm">{formatDateTime(entry.updatedAt)}</p>
                        </div>
                        <div className="space-y-1">
                          <h5 className="text-sm font-medium">Next Retry</h5>
                          <p className="text-sm">{formatDateTime(entry.nextRetryAt)}</p>
                        </div>
                        <div className="space-y-1">
                          <h5 className="text-sm font-medium">Resolved</h5>
                          <p className="text-sm">
                            {entry.resolvedAt == null
                              ? 'Not resolved'
                              : formatDateTime(entry.resolvedAt)}
                          </p>
                        </div>
                        <div className="space-y-1 md:col-span-2">
                          <h5 className="text-sm font-medium">Smart Contract Address</h5>
                          <p className="text-sm font-mono break-all">
                            {entry.PaymentSource.smartContractAddress}
                          </p>
                        </div>
                        <div className="space-y-1 md:col-span-2">
                          <h5 className="text-sm font-medium">Last Error</h5>
                          <p className="text-sm font-mono break-all whitespace-pre-wrap">
                            {entry.lastError ?? 'No error recorded'}
                          </p>
                        </div>
                      </div>
                    </td>
                  </tr>
                ),
              ];
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
