import createHttpError from 'http-errors';
import { logger } from '@masumi/payment-core/logger';
import { HydraTransportAmbiguousError } from '@/lib/hydra';
import { describeErrorForOperator } from '@/services/hydra-head-error/operator-message';

/**
 * Start an executor and wait only until it accepts the work.
 *
 * A refusal before that is the answer, with the reason the row records, shown
 * even for a 5xx: in production a hidden message reads only "Bad Gateway" or
 * "Internal Server Error". Once accepted the answer has gone out, and the log is
 * where a later failure goes.
 */
export function answerOnceAccepted(
	start: (onAccepted: () => void) => Promise<unknown>,
	failureLogPrefix: string,
): Promise<void> {
	let accepted = false;
	return new Promise<void>((resolve, reject) => {
		void start(() => {
			accepted = true;
			resolve();
		}).then(
			() => resolve(),
			(error: unknown) => {
				if (accepted) {
					logger.error(`${failureLogPrefix}: ${describeErrorForOperator(error)}`);
					return;
				}
				reject(
					createHttpError.isHttpError(error)
						? Object.assign(error, { expose: true })
						: // The node did not answer: what it was sent may still apply.
							createHttpError(
								error instanceof HydraTransportAmbiguousError ? 504 : 500,
								describeErrorForOperator(error),
								{ expose: true },
							),
				);
			},
		);
	});
}
