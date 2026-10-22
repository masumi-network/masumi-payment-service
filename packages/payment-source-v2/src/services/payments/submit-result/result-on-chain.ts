import { SmartContractState } from '@/utils/generator/contract-generator';
import type { DecodedV1ContractDatum } from '@/utils/converter/string-datum-convert';

/**
 * Whether the escrow already carries the result this request still asks to submit.
 *
 * A result the head rejected can confirm later. Datum sync then moves the escrow
 * to ResultSubmitted, but the shared transition table keeps the request at
 * SubmitResultRequested, and the validator accepts the same result a second time.
 */
export function isRequestedResultOnChain(
	decodedContract: Pick<DecodedV1ContractDatum, 'state' | 'resultHash'>,
	requestedResultHash: string | null,
): boolean {
	return (
		requestedResultHash != null &&
		decodedContract.resultHash != null &&
		decodedContract.resultHash.toLowerCase() === requestedResultHash.toLowerCase() &&
		(decodedContract.state === SmartContractState.ResultSubmitted ||
			decodedContract.state === SmartContractState.Disputed)
	);
}
