/**
 * Recording what went wrong on a head.
 *
 * Its own module rather than a helper on the head route, because the connection
 * manager needs it too and the route already imports the connection manager —
 * reaching back the other way would be a cycle. The route re-exports it so
 * existing callers are unaffected.
 */

import { HydraErrorType, HydraHeadStatus } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';

export async function recordHeadError(
	hydraHeadId: string,
	headStatus: HydraHeadStatus,
	errorType: HydraErrorType,
	error: unknown,
	clientInput: string,
): Promise<void> {
	try {
		const errorMessage = error instanceof Error ? error.message : String(error);
		await prisma.hydraHeadError.create({
			data: {
				hydraHeadId,
				errorType,
				errorMessage,
				headStatus,
				clientInput,
				errorAt: new Date(),
			},
		});
	} catch (logError) {
		logger.error('[HydraAPI] Failed to record head error', { hydraHeadId, logError });
	}
}
