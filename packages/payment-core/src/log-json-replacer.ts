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
