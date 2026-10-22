import { PaymentAction } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { connectPreviousAction, createNextPaymentAction } from '@/services/shared';
import { unlockHotWalletIfNoPendingTransaction } from '../../wallet-lock-helpers';

type AlreadySubmittedRequest = {
	id: string;
	nextActionId: string;
	NextAction: { resultHash: string | null };
	SmartContractWallet: { id: string; lockedAt: Date | null } | null;
};

/**
 * Finishes an L2 submit whose result the escrow already holds: the request
 * waits for the next external action and the hot wallet is released.
 */
export async function finishL2SubmitAlreadyOnChain(request: AlreadySubmittedRequest, txHash: string): Promise<void> {
	await prisma.paymentRequest.update({
		where: { id: request.id, nextActionId: request.nextActionId },
		data: {
			...connectPreviousAction(request.nextActionId),
			...createNextPaymentAction(PaymentAction.WaitingForExternalAction, {
				resultHash: request.NextAction.resultHash,
			}),
		},
	});
	await unlockHotWalletIfNoPendingTransaction(
		request.SmartContractWallet!.id,
		'submit-result-l2-already-on-chain',
		request.SmartContractWallet!.lockedAt!,
	);
	logger.info('L2 submit-result skipped; the escrow already holds the requested result', {
		requestId: request.id,
		txHash,
	});
}
