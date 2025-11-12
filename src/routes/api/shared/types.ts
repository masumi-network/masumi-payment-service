import { $Enums } from '@prisma/client';

/**
 * Common handler options passed to all authenticated endpoints
 */
export interface ApiHandlerOptions {
  id: string;
  permission: $Enums.Permission;
  networkLimit: $Enums.Network[];
  usageLimited: boolean;
}
