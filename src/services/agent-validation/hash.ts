import { canonicalize } from 'json-canonicalize';
import { generateSHA256Hash } from '@/utils/crypto';

/**
 * MIP-004 / MIP-003 hashes, computed the way the marketplace (Sokosumi)
 * verifies them, so a match here means a match for a real buyer.
 */

/** The exact string that is hashed for an input: identifierFromPurchaser + ";" + JCS(inputData). */
export const inputPreimage = (inputData: unknown, identifierFromPurchaser: string): string =>
	`${identifierFromPurchaser};${canonicalize(inputData)}`;

/** sha256(identifierFromPurchaser + ";" + JCS(inputData)) */
export const hashInput = (inputData: unknown, identifierFromPurchaser: string): string =>
	generateSHA256Hash(inputPreimage(inputData, identifierFromPurchaser));

/** sha256(identifierFromPurchaser + JCS(inputData)): older agents hashed without the ";" delimiter, and the marketplace still verifies it. */
export const hashInputDeprecated = (inputData: unknown, identifierFromPurchaser: string): string =>
	generateSHA256Hash(`${identifierFromPurchaser}${canonicalize(inputData)}`);

/** The exact string that is hashed for a result: identifierFromPurchaser + ";" + the JSON-escaped result. */
export const resultPreimage = (result: string, identifierFromPurchaser: string): string =>
	`${identifierFromPurchaser};${JSON.stringify(result).slice(1, -1)}`;

/**
 * sha256(identifierFromPurchaser + ";" + JSON-escaped result).
 * MIP-004 says "raw string", but Sokosumi and pip-masumi hash the escaped form
 * (JSON.stringify without the surrounding quotes); the buyer's check is what counts.
 */
export const hashResult = (result: string, identifierFromPurchaser: string): string =>
	generateSHA256Hash(resultPreimage(result, identifierFromPurchaser));

/**
 * sha256 of the canonical JSON of the `input_schema` object exactly as given. The marketplace hashes its
 * zod-normalized copy of the schema (unknown keys dropped, values coerced), which can differ for sloppy
 * schemas; compare with the agent's own computation before relying on this for provide_input.
 */
export const hashInputSchema = (inputSchema: unknown): string => generateSHA256Hash(inputSchemaPreimage(inputSchema));

/** The exact string that is hashed for an input schema: its canonical JSON. */
export const inputSchemaPreimage = (inputSchema: unknown): string => canonicalize(inputSchema);
