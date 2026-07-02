import { RegistryEntry } from '@/lib/api/generated';

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
