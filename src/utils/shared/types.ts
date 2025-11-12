import { $Enums } from '@prisma/client';

export interface ApiHandlerOptions {
  id: string;
  permission: $Enums.Permission;
  networkLimit: $Enums.Network[];
  usageLimited: boolean;
}
