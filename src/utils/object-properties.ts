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

export const isObject = (value: unknown): value is object => typeof value === 'object' && value !== null;

export const isPlainObject = (value: unknown): value is RuntimeObject => isObject(value) && !Array.isArray(value);

export const hasOwn = (value: object, key: string | symbol): boolean => Object.hasOwn(value, key);

export const getOwnValue = (value: object, key: string | symbol): RuntimePropertyValue | undefined =>
	hasOwn(value, key) ? (value as RuntimeObject)[key] : undefined;

export const getOwnString = (value: object, key: string | symbol): string | undefined => {
	const propertyValue = getOwnValue(value, key);
	return typeof propertyValue === 'string' ? propertyValue : undefined;
};

export const getOwnPlainObject = (value: object, key: string | symbol): RuntimeObject | undefined => {
	const propertyValue = getOwnValue(value, key);
	return isPlainObject(propertyValue) ? propertyValue : undefined;
};

export const getOwnArray = (value: object, key: string | symbol): RuntimePropertyValue[] | undefined => {
	const propertyValue = getOwnValue(value, key);
	return Array.isArray(propertyValue) ? propertyValue : undefined;
};

export const getOwnEntries = (value: object): Array<readonly [string, RuntimePropertyValue]> =>
	Object.keys(value).map((key) => [key, getOwnValue(value, key)] as const);
