/** Bind fallback nonexecution evidence to one durable Close admission. */
export const CLOSE_NONEXECUTION_CLIENT_INPUT_PREFIX = 'CloseNonexecution:';

export function closeNonexecutionClientInput(closeAdmissionId: string): string {
	return `${CLOSE_NONEXECUTION_CLIENT_INPUT_PREFIX}${closeAdmissionId}`;
}
