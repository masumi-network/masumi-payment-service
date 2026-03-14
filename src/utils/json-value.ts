import type { Prisma } from '@/generated/prisma/client';

type JsonPrimitive = string | number | boolean | null;

export type JsonInput = JsonPrimitive | bigint | Date | JsonInput[] | { [key: string]: JsonInput | undefined };

export type Jsonified<T> = T extends Date | bigint
	? string
	: T extends JsonPrimitive
		? T
		: T extends Array<infer Item>
			? Array<Jsonified<Item>>
			: T extends object
				? {
						[Key in keyof T]: T[Key] extends undefined ? never : Jsonified<Exclude<T[Key], undefined>>;
					}
				: never;

export function toPrismaJsonValue<T extends JsonInput>(value: T): Jsonified<T> {
	if (value === null) {
		return value as Jsonified<T>;
	}

	switch (typeof value) {
		case 'string':
		case 'number':
		case 'boolean':
			return value as Jsonified<T>;
		case 'bigint':
			return value.toString() as Jsonified<T>;
		default:
			break;
	}

	if (value instanceof Date) {
		return value.toISOString() as Jsonified<T>;
	}

	if (Array.isArray(value)) {
		return value.map((item) => toPrismaJsonValue(item)) as Jsonified<T>;
	}

	const jsonEntries = Object.entries(value).flatMap(([key, entryValue]) =>
		entryValue === undefined ? [] : [[key, toPrismaJsonValue(entryValue)] as const],
	);

	return Object.fromEntries(jsonEntries) as Jsonified<T>;
}

export function toPrismaInputJsonValue<T extends JsonInput>(value: T): Prisma.InputJsonValue {
	return toPrismaJsonValue(value) as Prisma.InputJsonValue;
}
