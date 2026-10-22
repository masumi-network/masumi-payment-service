/**
 * Which error a waiting Init fails with decides what its route does next.
 *
 * The route records a HydraPostTxRejectedError at once: the InitTx never reached
 * the chain, and the connection manager leaves that record to the route. A plain
 * CommandFailed goes through the timeout diagnosis, because the node also sends
 * it for a head that has already initialized. Mixing the two up either drops the
 * only record of a refusal or fails a head that did initialize.
 */

import { describe, expect, it } from '@jest/globals';
import { HydraCommandRejectedError, HydraPostTxRejectedError } from './errors';
import { handleWsResponse } from './node-frames';

const HEAD_ID = 'a'.repeat(56);

function initRejection(frame: object) {
	const outcome = handleWsResponse(JSON.stringify(frame), 'Init', undefined, HEAD_ID);
	return outcome.kind === 'reject' ? outcome.error : outcome;
}

describe('handleWsResponse for a waiting Init', () => {
	it('fails a refused InitTx post as a failed post', () => {
		const error = initRejection({
			tag: 'PostTxOnChainFailed',
			postChainTx: { tag: 'InitTx' },
			postTxError: { tag: 'NoSeedInput' },
		});
		expect(error).toBeInstanceOf(HydraPostTxRejectedError);
	});

	it('fails a CommandFailed as a plain refusal', () => {
		const error = initRejection({ tag: 'CommandFailed', clientInput: { tag: 'Init' } });
		expect(error).toBeInstanceOf(HydraCommandRejectedError);
		expect(error).not.toBeInstanceOf(HydraPostTxRejectedError);
	});
});
