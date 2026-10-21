import Link from 'next/link';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useAppContext } from '@/lib/contexts/AppContext';
import { useNodeChecks } from '@/lib/hooks/useNodeChecks';
import { CheckList } from './CheckList';

/** Is this node set up, and funded well enough, to host an agent? */
export function NodeCheck({ compact = false }: { compact?: boolean }) {
  const { network } = useAppContext();
  const { checks, isLoading, isFetching, refetch } = useNodeChecks();

  return (
    <div className="space-y-4">
      {!compact && (
        <p className="text-sm text-muted-foreground">
          Checks the payment source, the selling and purchasing wallets, and whether they hold
          enough on {network} to register an agent and run a test purchase.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void refetch()}
          disabled={isLoading || isFetching}
        >
          <RefreshCw className={isFetching ? 'animate-spin' : ''} aria-hidden />
          Check again
        </Button>
        <Button asChild variant="ghost" size="sm">
          <Link href="/wallets">Open Wallets</Link>
        </Button>
        <Button asChild variant="ghost" size="sm">
          <Link href="/setup">Open Setup</Link>
        </Button>
      </div>
      {isLoading ? <Skeleton className="h-40 w-full" /> : <CheckList checks={checks} />}
    </div>
  );
}
