import { z } from '@masumi/payment-core/zod';


export const searchQuerySchema = z
	.string()
	.optional()
	.describe(
		'Free-text search. Matches ID, blockchain identifier (exact), agent identifier, agent name, input hash, result hash, current or historical transaction hash, smart contract wallet address, on-chain state, or amount.',
	);

export const agentIdentifierFilterSchema = z
	.string()
	.optional()
	.describe(
		'Restrict results to one or more agents by exact agent identifier. Accepts a comma-separated list. Prefer this over searchQuery when filtering by agent: it is an exact match and will not match other fields.',
	);
