import { $Enums } from '@/generated/prisma/client';

export interface ApiHandlerOptions {
  id: string;
  permission: $Enums.Permission;
  networkLimit: $Enums.Network[];
  usageLimited: boolean;
}
