import { Skeleton } from '@/components/ui/skeleton';
import { CopyButton } from '@/components/ui/copy-button';
import { shortenAddress } from '@/lib/utils';
import { useRegistryEntryByAgentIdentifier } from '@/lib/queries/useRegistryEntryByAgentIdentifier';
import { useAgentDetailsDialog } from '@/lib/contexts/AgentDetailsDialogContext';

type Props = {
  agentIdentifier: string | null | undefined;
  smartContractAddress: string | null | undefined;
};

export function TransactionAgentIdentifierCell({ agentIdentifier, smartContractAddress }: Props) {
  const { openAgentDetails } = useAgentDetailsDialog();
  const { data: registryEntry, isLoading } = useRegistryEntryByAgentIdentifier({
    agentIdentifier,
    smartContractAddress,
    enabled: Boolean(agentIdentifier && smartContractAddress),
  });

  if (!agentIdentifier) {
    return <span className="text-sm text-muted-foreground">—</span>;
  }

  if (!smartContractAddress) {
    return (
      <div className="flex items-center gap-2 min-w-0">
        <span className="font-mono text-sm text-muted-foreground truncate" title={agentIdentifier}>
          {shortenAddress(agentIdentifier)}
        </span>
        <CopyButton value={agentIdentifier} />
      </div>
    );
  }

  if (isLoading) {
    return <Skeleton className="h-5 w-full max-w-[140px]" />;
  }

  const short = shortenAddress(agentIdentifier);

  if (registryEntry) {
    return (
      <div className="flex items-center gap-2 min-w-0">
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
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 min-w-0">
      <span className="font-mono text-sm text-muted-foreground truncate" title={agentIdentifier}>
        {short}
      </span>
      <CopyButton value={agentIdentifier} />
    </div>
  );
}
