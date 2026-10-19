import { format } from 'winston';
import { getOwnEntries, getOwnValue, type RuntimeObject } from './object-properties';

const REPEATED_ERROR = '[Repeated Error]';

/**
 * A JSON replacer for one production log line.
 *
 * An Error's `name`, `message`, `stack` and `cause` are not own enumerable
 * properties, so plain JSON turns `logger.error('...', { error })` into
 * `"error":{}` (or into only the enumerable extras, such as Prisma's
 * `clientVersion`). This writes them out explicitly, at any depth, and keeps
 * the enumerable extras (`code`, `meta`, ...) next to them.
 *
 * Each Error is written in full once per line; any later reference to it on
 * the same line is written as `[Repeated Error]`. Without that, an error that
 * reaches itself (`error.cause = error`) or is shared by several branches is
 * copied once per path, which grows exponentially. The set belongs to this one
 * replacer, so an error logged again after it changed is written as it is now.
 *
 * BigInt becomes a string, as in logform's default replacer, which this
 * replaces.
 */
export function createLogJsonReplacer(): (key: string, value: unknown) => unknown {
	const writtenErrors = new WeakSet<Error>();
	return (_key, value) => {
		if (typeof value === 'bigint') return value.toString();
		if (!(value instanceof Error)) return value;
		if (writtenErrors.has(value)) return REPEATED_ERROR;
		writtenErrors.add(value);
		try {
			const fields: RuntimeObject = {};
			for (const [entryKey, entryValue] of getOwnEntries(value)) fields[entryKey] = entryValue;
			fields.name = value.name;
			fields.message = value.message;
			if (value.stack) fields.stack = value.stack;
			const cause = getOwnValue(value, 'cause');
			if (cause !== undefined) fields.cause = cause;
			return fields;
		} catch {
			// A throwing getter must not turn the log call into a new exception.
			return '[Unserializable Error]';
		}
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
