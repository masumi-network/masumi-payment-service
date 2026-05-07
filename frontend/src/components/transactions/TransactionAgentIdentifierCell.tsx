import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { CopyButton } from '@/components/ui/copy-button';
import { shortenAddress } from '@/lib/utils';
import { useRegistryEntryByAgentIdentifier } from '@/lib/queries/useRegistryEntryByAgentIdentifier';
import { useAgentDetailsDialog } from '@/lib/contexts/AgentDetailsDialogContext';

type Props = {
  agentIdentifier: string | null | undefined;
  smartContractAddress: string | null | undefined;
  /** Payment source network for this row — keeps registry lookup stable if global network changes. */
  network?: string | null | undefined;
};

/** Start registry lookup once the cell is near/on screen to avoid N parallel calls for off-screen rows. */
export function TransactionAgentIdentifierCell({
  agentIdentifier,
  smartContractAddress,
  network,
}: Props) {
  const { openAgentDetails } = useAgentDetailsDialog();
  const containerRef = useRef<HTMLDivElement>(null);
  const [shouldResolve, setShouldResolve] = useState(false);

  useEffect(() => {
    if (!agentIdentifier || !smartContractAddress) return;
    const el = containerRef.current;
    if (!el) return;

    if (typeof IntersectionObserver === 'undefined') {
      queueMicrotask(() => setShouldResolve(true));
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setShouldResolve(true);
          observer.disconnect();
        }
      },
      { root: null, rootMargin: '160px', threshold: 0 },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [agentIdentifier, smartContractAddress]);

  const { data: registryEntry, isLoading } = useRegistryEntryByAgentIdentifier({
    agentIdentifier,
    smartContractAddress,
    network,
    enabled: Boolean(agentIdentifier && smartContractAddress && shouldResolve),
  });

  if (!agentIdentifier) {
    return <span className="text-sm text-muted-foreground">—</span>;
  }

  const short = shortenAddress(agentIdentifier);

  if (!smartContractAddress) {
    return (
      <div className="flex items-center gap-2 min-w-0">
        <span className="font-mono text-sm text-muted-foreground truncate" title={agentIdentifier}>
          {short}
        </span>
        <CopyButton value={agentIdentifier} />
      </div>
    );
  }

  const mutedIdentifier = (
    <>
      <span className="font-mono text-sm text-muted-foreground truncate" title={agentIdentifier}>
        {short}
      </span>
      <CopyButton value={agentIdentifier} />
    </>
  );

  let cellBody: ReactNode;
  if (!shouldResolve || isLoading) {
    cellBody = !shouldResolve ? mutedIdentifier : <Skeleton className="h-5 w-full max-w-[140px]" />;
  } else if (registryEntry) {
    cellBody = (
      <>
        <button
          type="button"
          className="font-mono text-sm text-primary hover:underline truncate text-left"
          title={agentIdentifier}
          onClick={(e) => {
            e.stopPropagation();
            openAgentDetails(registryEntry);
          }}
        >
          {short}
        </button>
        <CopyButton value={agentIdentifier} />
      </>
    );
  } else {
    cellBody = mutedIdentifier;
  }

  return (
    <div ref={containerRef} className="flex items-center gap-2 min-w-0">
      {cellBody}
    </div>
  );
}
