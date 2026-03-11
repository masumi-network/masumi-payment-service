import { $Enums } from '@/generated/prisma/client';

export interface ApiHandlerOptions {
	id: string;
	networkLimit: $Enums.Network[];
	usageLimited: boolean;
}
