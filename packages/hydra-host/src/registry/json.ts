/**
 * Minimal structural helpers for reading untrusted JSON.
 *
 * Deliberately duplicated rather than imported from `@masumi/payment-core`:
 * the Hydra Host ships as its own container and must not pull in the payment
 * service's dependency graph (Prisma, mesh, winston) to read a config file.
 *
 * The shape mirrors `payment-core/object-properties` so the repo's ban on
 * unknown-valued map types is satisfied without `Record<string, unknown>`.
 */

type RuntimeCallable = (...args: never[]) => unknown;

export type RuntimePropertyValue =
	| string
	| number
	| boolean
	| bigint
	| symbol
	| RuntimeCallable
	| object
	| null
	| undefined;

export interface RuntimeObject {
	[key: string]: RuntimePropertyValue;
	[key: symbol]: RuntimePropertyValue;
}

const isObject = (value: unknown): value is object => typeof value === 'object' && value !== null;

export const isPlainObject = (value: unknown): value is RuntimeObject => isObject(value) && !Array.isArray(value);

export const getOwnValue = (value: object, key: string): RuntimePropertyValue | undefined =>
	Object.hasOwn(value, key) ? (value as RuntimeObject)[key] : undefined;

export const getOwnString = (value: object, key: string): string | undefined => {
	const property = getOwnValue(value, key);
	return typeof property === 'string' ? property : undefined;
};

export const getOwnInteger = (value: object, key: string): number | undefined => {
	const property = getOwnValue(value, key);
	return typeof property === 'number' && Number.isSafeInteger(property) ? property : undefined;
};
