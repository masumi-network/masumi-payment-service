/** Registry agent names are unbounded TEXT on-chain; cap the denormalized copy we store/search on. */
export const MAX_AGENT_NAME_LENGTH = 250;

/** Trim, coerce empty to null, and cap length. Single source of truth for the stored agentName. */
export function normalizeAgentName(name: string | null | undefined): string | null {
	const trimmed = name?.trim();
	if (!trimmed) return null;
	return trimmed.length > MAX_AGENT_NAME_LENGTH ? trimmed.slice(0, MAX_AGENT_NAME_LENGTH) : trimmed;
}
