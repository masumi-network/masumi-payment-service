import { SmartContractState } from '@/utils/generator/contract-generator';
import type { DecodedV1ContractDatum } from '@/utils/converter/string-datum-convert';

/**
 * Whether the escrow already carries the result this request still asks to submit.
 *
 * A result the head rejected can confirm later. The request is then back at
 * SubmitResultRequested, and the shared transition table keeps it there when the
 * escrow reaches ResultSubmitted, because a different hash is a real rotation.
 * The validator accepts the same result a second time, so callers read a match as
 * a submit that already happened.
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
