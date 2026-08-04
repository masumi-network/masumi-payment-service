/**
 * What went wrong on a head.
 *
 * The table has always counted errors and nothing ever showed them, which is
 * worse than not counting: an operator is told twice that something failed and
 * given no way to find out what. The endpoint existed the whole time.
 *
 * Newest first, because the last failure is the one being investigated. The
 * message carries the node's own reason — `NoSeedInput` and friends are the
 * difference between "fund the node" and "something is wrong with the head" —
 * so it is shown verbatim rather than summarised.
 */

import { useState } from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';
import { toast } from 'react-toastify';
import { useResync } from '@/lib/hooks/useResync';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useAppContext } from '@/lib/contexts/AppContext';
import { clearHydraHeadErrors, useHydraHeadErrors } from '@/lib/hooks/useHydraHeads';

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const minutes = Math.round((Date.now() - then) / 60_000);
  if (!Number.isFinite(minutes)) return '';
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function HydraHeadErrors({
  headId,
  count,
  // The surrounding collapsible already names the section and shows the count,
  // so repeating both inside it read as two nested "Errors" headings.
  showHeading = true,
}: {
  headId: string;
  count: number;
  showHeading?: boolean;
}) {
  const { errors, isLoading, refetch } = useHydraHeadErrors(headId);
  const { apiClient } = useAppContext();
  const resync = useResync();
  const [isClearing, setIsClearing] = useState(false);

  async function handleClear() {
    setIsClearing(true);
    try {
      const result = await clearHydraHeadErrors(apiClient, { headId });
      toast.success(`Cleared ${result.cleared} error${result.cleared === 1 ? '' : 's'}`);
      await resync('hydra');
      await refetch();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to clear the errors');
    } finally {
      setIsClearing(false);
    }
  }

  if (count === 0 && errors.length === 0) {
    return null;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {showHeading ? (
          <h3 className="flex items-center gap-2 font-medium">
            <AlertCircle className="h-4 w-4 text-red-600 dark:text-red-400" />
            Errors
            <Badge variant="outline">{errors.length || count}</Badge>
          </h3>
        ) : (
          <span />
        )}
        {errors.length > 0 && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void handleClear()}
            disabled={isClearing}
            title="These are a log, not state. Clearing them affects nothing but this list."
          >
            {isClearing && <Loader2 className="h-4 w-4 animate-spin" />}
            Clear
          </Button>
        )}
      </div>

      {isLoading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading…
        </p>
      ) : errors.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          The count is recorded but the entries are no longer available.
        </p>
      ) : (
        <ul className="divide-y rounded-md border">
          {errors.map((error) => (
            <li key={error.id} className="space-y-1 px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" className="text-red-600 dark:text-red-400">
                  {error.errorType}
                </Badge>
                {error.clientInput && <Badge variant="outline">{error.clientInput}</Badge>}
                <span className="text-xs text-muted-foreground">
                  {relativeTime(error.errorAt)} · while {error.headStatus}
                </span>
              </div>
              <p className="break-words text-sm">{error.errorMessage}</p>
              {error.txHash && (
                <p className="break-all font-mono text-xs text-muted-foreground">{error.txHash}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
