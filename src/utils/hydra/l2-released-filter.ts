import type { Prisma } from '@/generated/prisma/client';

/**
 * Matches a Transaction row whose L2 reservation was released by any kind of
 * release. A later confirmation of such a body must halt replay, so every
 * release stamp belongs here.
 */
export const L2_RELEASED_RESERVATION_FILTER = {
	OR: [
		{ l2ReleasedByInputProofAt: { not: null } },
		{ l2ReleasedByOperatorAt: { not: null } },
		{ l2ReleasedByUnspentInputsAt: { not: null } },
	],
} satisfies Prisma.TransactionWhereInput;
