import { checkCoworkerMetadata } from './coworker';
import { hashInput, hashInputSchema, hashResult, inputPreimage, inputSchemaPreimage, resultPreimage } from './hash';
import { checkInputSchema } from './input-schema';
import { fail, type JsonObject, type ValidationCheck } from './types';

/** Logic behind the standalone validation tools: check pasted JSON, and show how a hash is built. */

type ValidateKind = 'input_schema' | 'coworker_metadata';

export function validateJsonText(kind: ValidateKind, text: string): ValidationCheck[] {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		return [
			fail('agent.json.parse', 'Text is valid JSON', {
				detail: error instanceof Error ? error.message : 'The text could not be parsed.',
				fix: 'Fix the JSON syntax (a missing comma, quote or bracket is the usual cause) and check again.',
			}),
		];
	}
	return kind === 'input_schema' ? checkInputSchema(value) : checkCoworkerMetadata(value);
}

type HashRequest = {
	kind: 'input' | 'result' | 'input_schema';
	identifierFromPurchaser?: string;
	inputData?: JsonObject;
	result?: string;
	json?: string;
};

type HashOutcome = { ok: true; hash: string; preimage: string } | { ok: false; message: string };

/** The hash plus the exact string it was computed from, so a mismatch can be compared character by character. */
export function computeHash(request: HashRequest): HashOutcome {
	const { kind, identifierFromPurchaser } = request;
	if (kind === 'input_schema') {
		if (request.json === undefined) return { ok: false, message: 'json is required to hash an input schema.' };
		let schema: unknown;
		try {
			schema = JSON.parse(request.json);
		} catch {
			return { ok: false, message: 'json is not valid JSON.' };
		}
		return { ok: true, hash: hashInputSchema(schema), preimage: inputSchemaPreimage(schema) };
	}
	if (identifierFromPurchaser === undefined) {
		return { ok: false, message: 'identifierFromPurchaser is required to hash an input or a result.' };
	}
	if (kind === 'input') {
		const inputData = request.inputData ?? {};
		return {
			ok: true,
			hash: hashInput(inputData, identifierFromPurchaser),
			preimage: inputPreimage(inputData, identifierFromPurchaser),
		};
	}
	if (request.result === undefined) return { ok: false, message: 'result is required to hash a result.' };
	return {
		ok: true,
		hash: hashResult(request.result, identifierFromPurchaser),
		preimage: resultPreimage(request.result, identifierFromPurchaser),
	};
}
