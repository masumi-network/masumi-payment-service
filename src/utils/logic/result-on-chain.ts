import { OnChainState, PaymentAction } from '@/generated/prisma/client';
import { SmartContractState } from '@/utils/generator/contract-generator';
import type { DecodedV1ContractDatum } from '@/utils/converter/string-datum-convert';
import { convertNewPaymentActionAndError } from '@/utils/logic/state-transitions';

function holdsRequestedResult(
	isResultState: boolean,
	onChainResultHash: string | null,
	requestedResultHash: string | null,
): boolean {
	return (
		isResultState &&
		requestedResultHash != null &&
		onChainResultHash != null &&
		onChainResultHash.toLowerCase() === requestedResultHash.toLowerCase()
	);
}

/**
 * Whether the escrow already carries the result this request still asks to submit.
 *
 * A submit that was refused, or that threw, can still confirm later. The request
 * is then back at SubmitResultRequested, and the shared transition table keeps it
 * there when the escrow reaches ResultSubmitted, because a different hash is a
 * real rotation. The validator accepts the same result a second time, so callers
 * read a match as a submit that already happened.
 */
export function isRequestedResultOnChain(
	decodedContract: Pick<DecodedV1ContractDatum, 'state' | 'resultHash'>,
	requestedResultHash: string | null,
): boolean {
	return holdsRequestedResult(
		decodedContract.state === SmartContractState.ResultSubmitted ||
			decodedContract.state === SmartContractState.Disputed,
		decodedContract.resultHash,
		requestedResultHash,
	);
}

/**
 * The payment action a sync write moves to, and the result hash it keeps.
 *
 * Both sync paths create the next action without a hash, and the submit passes
 * select only requests that carry one. A request left at SubmitResultRequested
 * keeps its hash, and one whose result is already on chain counts as submitted.
 */
export function convertSyncedPaymentAction(
	currentAction: PaymentAction,
	requestedResultHash: string | null,
	newState: OnChainState,
	onChainResultHash: string | null,
) {
	const isRequestedResultConfirmed =
		currentAction === PaymentAction.SubmitResultRequested &&
		holdsRequestedResult(
			newState === OnChainState.ResultSubmitted || newState === OnChainState.Disputed,
			onChainResultHash,
			requestedResultHash,
		);
	const newAction = convertNewPaymentActionAndError(
		isRequestedResultConfirmed ? PaymentAction.SubmitResultInitiated : currentAction,
		newState,
	);
	return {
		...newAction,
		resultHash: newAction.action === PaymentAction.SubmitResultRequested ? requestedResultHash : undefined,
	};
}
