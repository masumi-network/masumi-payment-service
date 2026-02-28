import { z } from '@/utils/zod-openapi';

export type allowedFormat = string | number | boolean | null | undefined | Date;

export type allowedObject = {
	[key: string]: allowedFormat | allowedObject | allowedObject[] | allowedFormat[];
};

export const allowedFormatSchemaBase = z.union([
	z.string(),
	z.number(),
	z.boolean(),
	z.null(),
	z.undefined(),
	z.date(),
]);

export const allowedObjectSchemaBase = z.record(
	z.string(),
	allowedFormatSchemaBase.or(z.array(allowedFormatSchemaBase)),
);
export const allowedObjectSchema = z.record(
	z.string(),
	allowedObjectSchemaBase.or(allowedFormatSchemaBase).or(z.array(allowedFormatSchemaBase)),
);

export class HttpExistsError extends Error {
	id: string;
	object: any;
	constructor(message: string, id: string, object: allowedObject) {
		super(message);
		this.id = id;
		this.object = object;
	}
}
