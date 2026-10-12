import { getOwnEntries, getOwnValue, type RuntimeObject } from './object-properties';

/**
 * JSON replacer for the production log line.
 *
 * An Error's `name`, `message`, `stack` and `cause` are not own enumerable
 * properties, so plain JSON turns `logger.error('...', { error })` into
 * `"error":{}` (or into only the enumerable extras, such as Prisma's
 * `clientVersion`). This writes them out explicitly, at any depth, and keeps
 * the enumerable extras (`code`, `meta`, ...) next to them.
 *
 * BigInt becomes a string, as in logform's default replacer, which this
 * replaces.
 */
export function logJsonReplacer(_key: string, value: unknown): unknown {
	if (typeof value === 'bigint') return value.toString();
	if (!(value instanceof Error)) return value;
	const serialized: RuntimeObject = {};
	for (const [entryKey, entryValue] of getOwnEntries(value)) serialized[entryKey] = entryValue;
	serialized.name = value.name;
	serialized.message = value.message;
	if (value.stack) serialized.stack = value.stack;
	const cause = getOwnValue(value, 'cause');
	if (cause !== undefined) serialized.cause = cause;
	return serialized;
}

/**
 * How deep a log line is written before the rest becomes `[Object]`.
 *
 * Required with `logJsonReplacer`, not optional: the stringifier finds cycles
 * by object identity, and the replacer returns a new object for every Error,
 * so an Error that reaches itself again (`error.cause = error`, two errors
 * citing each other) is never seen as a cycle. Without a depth cap that
 * recursion overflows the stack, and winston rethrows it from the log call.
 */
export const LOG_JSON_MAXIMUM_DEPTH = 16;

/** The options to give winston's `format.json`. */
export const logJsonFormatOptions = { replacer: logJsonReplacer, maximumDepth: LOG_JSON_MAXIMUM_DEPTH };
