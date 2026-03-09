import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const OPENAPI_BASELINE_HASH = '0201cf508f4219e91be2df93edeb620433cba829238736c79cb570b5790c3999';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const OPENAPI_DOCUMENT_PATH = path.join(__dirname, 'openapi-docs.json');

export function openAPIJsonReplacer(_key: string, value: unknown): string | number | boolean | null {
	if (typeof value === 'bigint') {
		return value.toString();
	}
	if (value instanceof Date) {
		return value.toISOString();
	}
	if (typeof value === 'object' && value !== null) {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-return
		return JSON.parse(JSON.stringify(value));
	}
	if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
		return value;
	}
	return null;
}

export function serializeOpenAPIDocument(docs: unknown): string {
	return JSON.stringify(docs, openAPIJsonReplacer, 4);
}

export function hashOpenAPIDocument(serializedDocs: string): string {
	return createHash('sha256').update(serializedDocs).digest('hex');
}

export function readCheckedInOpenAPIDocument(): string {
	return fs.readFileSync(OPENAPI_DOCUMENT_PATH, 'utf-8');
}

export function writeOpenAPIDocument(docs: unknown) {
	fs.writeFileSync(OPENAPI_DOCUMENT_PATH, serializeOpenAPIDocument(docs), {
		encoding: 'utf-8',
	});
}
