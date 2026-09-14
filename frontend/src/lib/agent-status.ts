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
      return 'Registering';
    case 'RegistrationInitiated':
      return 'Registering';
    case 'RegistrationConfirmed':
      return 'Registered';
    case 'RegistrationFailed':
      return 'Registration Failed';
    case 'UpdateRequested':
      return 'Update pending';
    case 'UpdateInitiated':
      return 'Updating';
    case 'UpdateConfirmed':
      return 'Registered';
    case 'UpdateFailed':
      return 'Update Failed';
    case 'DeregistrationRequested':
      return 'Deregistration pending';
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

/** Short helper copy explaining in-flight registry operations (no SLA promises). */
export function getAgentStatusHelperText(state: RegistryEntry['state']): string | null {
  switch (state) {
    case 'RegistrationRequested':
      return 'Your registration is queued and will mint on-chain shortly.';
    case 'UpdateRequested':
      return 'Metadata update is queued and will apply on-chain shortly.';
    case 'DeregistrationRequested':
      return 'Deregistration is queued and will apply on-chain shortly.';
    default:
      return null;
  }
}

/** Placeholder when the agent identifier is not minted yet or is being replaced. */
export function getAgentIdentifierPlaceholder(state: RegistryEntry['state']): string {
  switch (state) {
    case 'RegistrationRequested':
    case 'RegistrationInitiated':
      return 'Minting on-chain…';
    case 'UpdateRequested':
    case 'UpdateInitiated':
      return 'Updating on-chain…';
    case 'DeregistrationRequested':
    case 'DeregistrationInitiated':
      return 'Deregistering on-chain…';
    default:
      return '—';
  }
}
