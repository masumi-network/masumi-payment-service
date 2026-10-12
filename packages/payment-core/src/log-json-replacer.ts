import { format } from 'winston';
import { getOwnEntries, getOwnValue, type RuntimeObject } from './object-properties';

/**
 * A JSON replacer for one production log line.
 *
 * An Error's `name`, `message`, `stack` and `cause` are not own enumerable
 * properties, so plain JSON turns `logger.error('...', { error })` into
 * `"error":{}` (or into only the enumerable extras, such as Prisma's
 * `clientVersion`). This writes them out explicitly, at any depth, and keeps
 * the enumerable extras (`code`, `meta`, ...) next to them.
 *
 * Each Error is serialized once per line and the same object is returned when
 * it is reached again. The stringifier finds cycles by object identity, so
 * that is what lets it write `[Circular]` for `error.cause = error` instead of
 * copying the error over and over. The cache belongs to this one replacer, so
 * an error logged again after it changed is written as it is now.
 *
 * BigInt becomes a string, as in logform's default replacer, which this
 * replaces.
 */
export function createLogJsonReplacer(): (key: string, value: unknown) => unknown {
	const serializedErrors = new WeakMap<Error, RuntimeObject | string>();
	return (_key, value) => {
		if (typeof value === 'bigint') return value.toString();
		if (!(value instanceof Error)) return value;
		const cached = serializedErrors.get(value);
		if (cached !== undefined) return cached;
		let serialized: RuntimeObject | string;
		try {
			const fields: RuntimeObject = {};
			for (const [entryKey, entryValue] of getOwnEntries(value)) fields[entryKey] = entryValue;
			fields.name = value.name;
			fields.message = value.message;
			if (value.stack) fields.stack = value.stack;
			const cause = getOwnValue(value, 'cause');
			if (cause !== undefined) fields.cause = cause;
			serialized = fields;
		} catch {
			// A throwing getter must not turn the log call into a new exception.
			serialized = '[Unserializable Error]';
		}
		serializedErrors.set(value, serialized);
		return serialized;
	};
}

/**
 * How deep a log line is written before the rest becomes `[Object]`. A
 * backstop: real log metadata reaches about five levels.
 */
export const LOG_JSON_MAXIMUM_DEPTH = 16;

const jsonFormat = format.json();

/** winston's `json` format, with a fresh error-aware replacer for every line. */
export const logJson = format((info) =>
	jsonFormat.transform(info, { replacer: createLogJsonReplacer(), maximumDepth: LOG_JSON_MAXIMUM_DEPTH }),
);
