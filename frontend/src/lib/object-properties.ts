type RuntimeCallable = (...args: never[]) => unknown;

export type RuntimeValue =
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
  [key: string]: RuntimeValue;
  [key: symbol]: RuntimeValue;
}

export const isObject = (value: unknown): value is object =>
  typeof value === 'object' && value !== null;

export const isPlainObject = (value: unknown): value is RuntimeObject =>
  isObject(value) && !Array.isArray(value);

export const getOwnValue = (value: object, key: string | symbol): RuntimeValue | undefined =>
  Object.hasOwn(value, key) ? (value as RuntimeObject)[key] : undefined;

export const getOwnString = (value: object, key: string | symbol): string | undefined => {
  const propertyValue = getOwnValue(value, key);
  return typeof propertyValue === 'string' ? propertyValue : undefined;
};

export const getOwnPlainObject = (
  value: object,
  key: string | symbol,
): RuntimeObject | undefined => {
  const propertyValue = getOwnValue(value, key);
  return isPlainObject(propertyValue) ? propertyValue : undefined;
};
