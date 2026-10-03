import { z } from '@masumi/payment-core/zod';

/**
 * Bounds mirroring the exact agent identifier accepted on /registry
 * (src/routes/api/registry/schemas.ts) so one parameter name cannot mean two
 * different things across the API.
 */
const AGENT_IDENTIFIER_MIN_LENGTH = 57;
const AGENT_IDENTIFIER_MAX_LENGTH = 250;
/** Caps how many identifiers one request can expand into a single `IN (...)`. */
const AGENT_IDENTIFIER_MAX_ENTRIES = 20;

export const searchQuerySchema = z
	.string()
	.max(500)
	.optional()
	.describe(
		'Free-text search. Matches ID, blockchain identifier (exact), agent identifier, agent name, smart contract wallet address, on-chain state, layer ("L1", "L2" or "hydra"), or amount. A query that looks like a hash (5+ hex characters) additionally matches input hash, result hash, Hydra head ID, and the current or any historical transaction hash. Matching is case-insensitive, and "%" and "_" are matched literally.',
	);

export const agentIdentifierFilterSchema = z
	.string()
	.max(AGENT_IDENTIFIER_MAX_ENTRIES * (AGENT_IDENTIFIER_MAX_LENGTH + 1))
	.optional()
	.superRefine((value, ctx) => {
		if (value === undefined) return;
		const identifiers = value
			.split(',')
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0);
		if (identifiers.length > AGENT_IDENTIFIER_MAX_ENTRIES) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: `At most ${AGENT_IDENTIFIER_MAX_ENTRIES} agent identifiers can be supplied`,
			});
			return;
		}
		// An empty list is allowed and matches nothing, so a caller joining an
		// empty selection gets zero rows rather than every agent's transactions.
		for (const identifier of identifiers) {
			if (identifier.length < AGENT_IDENTIFIER_MIN_LENGTH || identifier.length > AGENT_IDENTIFIER_MAX_LENGTH) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: `Each agent identifier must be between ${AGENT_IDENTIFIER_MIN_LENGTH} and ${AGENT_IDENTIFIER_MAX_LENGTH} characters`,
				});
				return;
			}
		}
	})
	.describe(
		`Restrict results to one or more agents by exact agent identifier, as a comma-separated list of at most ${AGENT_IDENTIFIER_MAX_ENTRIES}. Prefer this over searchQuery when filtering by agent: it is an exact (case-insensitive) match and will not match other fields. Supplying this field does not apply the default Web3CardanoV1 compatibility filter, so agents on a Web3CardanoV2 source are found too. A value naming no agent matches nothing.`,
	);
