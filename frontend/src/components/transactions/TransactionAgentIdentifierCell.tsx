import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { CopyButton } from '@/components/ui/copy-button';
import { shortenAddress } from '@/lib/utils';
import { useRegistryEntryByAgentIdentifier } from '@/lib/queries/useRegistryEntryByAgentIdentifier';
import { useAgentDetailsDialog } from '@/lib/contexts/AgentDetailsDialogContext';
import type { NetworkType } from '@/lib/contexts/AppContext';

type Props = {
  agentIdentifier: string | null | undefined;
  smartContractAddress: string | null | undefined;
  /** Pre-resolved name (e.g. from agent-name transaction search). */
  agentName?: string | null;
  /** Payment source network for this row — keeps registry lookup stable if global network changes. */
  network?: NetworkType | null | undefined;
};

/** Start registry lookup once the cell is near/on screen to avoid N parallel calls for off-screen rows. */
export function TransactionAgentIdentifierCell({
  agentIdentifier,
  smartContractAddress,
  agentName,
  network,
}: Props) {
  const { openAgentDetails } = useAgentDetailsDialog();
  const containerRef = useRef<HTMLDivElement>(null);
  const [shouldResolve, setShouldResolve] = useState(Boolean(agentName));

  useEffect(() => {
    if (agentName) {
      queueMicrotask(() => setShouldResolve(true));
      return;
    }
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
  }, [agentIdentifier, smartContractAddress, agentName]);

  const { data: registryEntry, isLoading } = useRegistryEntryByAgentIdentifier({
    agentIdentifier,
    smartContractAddress,
    network,
    enabled: Boolean(agentIdentifier && smartContractAddress && shouldResolve && !agentName),
  });

  if (!agentIdentifier) {
    return <span className="text-sm text-muted-foreground">—</span>;
  }

  const short = shortenAddress(agentIdentifier);
  const resolvedName = agentName ?? registryEntry?.name ?? null;

  const mutedIdentifier = (
    <>
      <span className="font-mono text-sm text-muted-foreground truncate" title={agentIdentifier}>
        {short}
      </span>
      <CopyButton value={agentIdentifier} />
    </>
  );

  let cellBody: ReactNode;
  if (resolvedName) {
    const label = (
      <span className="text-sm truncate" title={resolvedName}>
        {resolvedName}
      </span>
    );

    if (registryEntry) {
      cellBody = (
        <>
          <button
            type="button"
            className="text-sm text-primary hover:underline truncate text-left"
            title={`${resolvedName} (${agentIdentifier})`}
            onClick={(e) => {
              e.stopPropagation();
              openAgentDetails(registryEntry);
            }}
          >
            {resolvedName}
          </button>
          <CopyButton value={agentIdentifier} />
        </>
      );
    } else {
      cellBody = (
        <>
          {label}
          <CopyButton value={agentIdentifier} />
        </>
      );
    }
  } else if (!shouldResolve || isLoading) {
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
  } else if (!smartContractAddress) {
    cellBody = mutedIdentifier;
  } else {
    cellBody = mutedIdentifier;
  }

  return (
    <div ref={containerRef} className="flex flex-col gap-0.5 min-w-0">
      <div className="flex items-center gap-2 min-w-0">{cellBody}</div>
      {resolvedName ? (
        <span className="font-mono text-xs text-muted-foreground truncate" title={agentIdentifier}>
          {short}
        </span>
      ) : null}
    </div>
  );
}
