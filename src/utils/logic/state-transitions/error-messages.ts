//TODO: Check error notes and possibly new error types
export const ERROR_MESSAGES = {
	INVALID_STATE_END:
		'Invalid state detected. Purchase request was in end state before. This indicates a database error or a bug',
	INVALID_STATE_EXTERNAL:
		'Invalid state detected. Someone else likely initiated a purchase request or this is a bug. Waiting for manual resolution',
	UNEXPECTED_STATE_CHANGE: 'Unexpected state change detected. This indicates a database error or a bug',
	UNEXPECTED_STATE_CHANGE_TIMEOUT: 'Unexpected state change detected. Possible a action could not be executed in time',
	UNEXPECTED_STATE_CHANGE_EXTERNAL: 'Unexpected state change detected. Possible a action was executed externally',
	AMOUNT_MISMATCH: 'Amount mismatch detected. Unexpected state change detected',
	AMOUNT_MISMATCH_END:
		'Amount mismatch detected. Invalid state detected. Purchase request was in end state before. This indicates a database error or a bug',
	MANUAL_ACTION_STATE_CHANGE: 'State change detected after manual action was required',
	AMOUNT_MISMATCH_MANUAL: 'Amount mismatch detected. State change detected after manual action was required',
};
