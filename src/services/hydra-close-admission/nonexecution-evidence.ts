/** Bind fallback nonexecution evidence to one durable Close admission. */
export function closeNonexecutionClientInput(closeAdmissionId: string): string {
	return `CloseNonexecution:${closeAdmissionId}`;
}
