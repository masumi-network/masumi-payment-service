import { $Enums } from '@/generated/prisma/client';

export interface ApiHandlerOptions {
	id: string;
	canRead: boolean;
	canPay: boolean;
	canAdmin: boolean;
	networkLimit: $Enums.Network[];
	usageLimited: boolean;
}
