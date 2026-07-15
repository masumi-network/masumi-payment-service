import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { resetAgentQueries } from '@/lib/queries/agent-cache';
import { AIAgentDetailsDialog } from '@/components/ai-agents/AIAgentDetailsDialog';
import type { RegistryEntry, A2aRegistryEntry } from '@/lib/api/generated';

type AgentDetailsEntry = RegistryEntry | A2aRegistryEntry;

export type OpenAgentDetailsOptions = {
  initialTab?: 'Details' | 'Earnings';
  /** When true, agent modal renders above another open dialog (e.g. transaction details). */
  stackOverParentModal?: boolean;
};

type AgentDetailsDialogContextValue = {
  openAgentDetails: (agent: AgentDetailsEntry, options?: OpenAgentDetailsOptions) => void;
  closeAgentDetails: () => void;
};

const AgentDetailsDialogContext = createContext<AgentDetailsDialogContextValue | undefined>(
  undefined,
);

export function AgentDetailsDialogProvider({ children }: { children: ReactNode }) {
  const [agent, setAgent] = useState<AgentDetailsEntry | null>(null);
  const [initialTab, setInitialTab] = useState<'Details' | 'Earnings'>('Details');
  const [elevatedStack, setElevatedStack] = useState(false);
  const queryClient = useQueryClient();

  const closeAgentDetails = useCallback(() => {
    setAgent(null);
    setInitialTab('Details');
    setElevatedStack(false);
  }, []);

  const openAgentDetails = useCallback(
    (next: AgentDetailsEntry, options?: OpenAgentDetailsOptions) => {
      setAgent(next);
      setInitialTab(options?.initialTab ?? 'Details');
      setElevatedStack(Boolean(options?.stackOverParentModal));
    },
    [],
  );

  const handleSuccess = useCallback(() => {
    // Deregister/delete/re-register from the details dialog changes list
    // membership, so clear the agent lists to their skeleton (reset) rather than
    // showing stale rows; balances refresh in place (invalidate). Delayed so the
    // tx has settled before the refetch runs.
    window.setTimeout(() => {
      resetAgentQueries(queryClient);
      void queryClient.invalidateQueries({ queryKey: ['wallets'] });
    }, 2000);
  }, [queryClient]);

  const value = useMemo(
    () => ({ openAgentDetails, closeAgentDetails }),
    [openAgentDetails, closeAgentDetails],
  );

  return (
    <AgentDetailsDialogContext.Provider value={value}>
      {children}
      <AIAgentDetailsDialog
        agent={agent}
        elevatedStack={elevatedStack}
        onClose={closeAgentDetails}
        onSuccess={handleSuccess}
        initialTab={initialTab}
      />
    </AgentDetailsDialogContext.Provider>
  );
}

export function useAgentDetailsDialog(): AgentDetailsDialogContextValue {
  const ctx = useContext(AgentDetailsDialogContext);
  if (!ctx) {
    throw new Error('useAgentDetailsDialog must be used within AgentDetailsDialogProvider');
  }
  return ctx;
}
