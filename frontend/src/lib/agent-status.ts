import { RegistryEntry } from '@/lib/api/generated';

/** Badge variants used to color an agent/inbox lifecycle state. */
type AgentStatusBadgeVariant = 'success' | 'destructive' | 'processing' | 'pending' | 'secondary';

/**
 * Map a registry/inbox lifecycle state to a Badge variant. Shared by the AI-agents
 * list + details dialog and the inbox list + details dialog so the four never drift
 * (they previously each carried a slightly different copy, some with a hardcoded
 * light-green class that broke in dark mode). `success`/`processing`/`pending` all
 * carry proper dark-mode colors via the Badge component.
 */
export function getAgentStatusBadgeVariant(status: string): AgentStatusBadgeVariant {
  // UpdateConfirmed is a live on-chain registration (with newer metadata).
  if (status === 'RegistrationConfirmed' || status === 'UpdateConfirmed') return 'success';
  if (status.includes('Failed')) return 'destructive';
  if (status.includes('Initiated')) return 'processing';
  if (status.includes('Requested')) return 'pending';
  return 'secondary';
}

/**
 * Map a registry entry's on-chain lifecycle state to a human-readable status
 * label. Shared by the AI-agents list page and the agent-details dialog so the
 * two never drift (a prior drift left the list page rendering raw `Update*`
 * enum text in status badges while the dialog showed friendly labels).
 */
export const parseAgentStatus = (status: RegistryEntry['state']): string => {
  switch (status) {
    case 'RegistrationRequested':
      return 'Pending';
    case 'RegistrationInitiated':
      return 'Registering';
    case 'RegistrationConfirmed':
      return 'Registered';
    case 'RegistrationFailed':
      return 'Registration Failed';
    case 'UpdateRequested':
      return 'Pending';
    case 'UpdateInitiated':
      return 'Updating';
    case 'UpdateConfirmed':
      return 'Registered';
    case 'UpdateFailed':
      return 'Update Failed';
    case 'DeregistrationRequested':
      return 'Pending';
    case 'DeregistrationInitiated':
      return 'Deregistering';
    case 'DeregistrationConfirmed':
      return 'Deregistered';
    case 'DeregistrationFailed':
      return 'Deregistration Failed';
    default:
      return status;
  }
};
