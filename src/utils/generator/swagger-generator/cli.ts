import { generateOpenAPI } from '.';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export function writeDocumentation(docs: unknown) {
	// Get the directory name in an ES module
	const __filename = fileURLToPath(import.meta.url);
	const __dirname = path.dirname(__filename);

	// Custom replacer function to handle BigInt
	const replacer = (key: string, value: unknown): string | number | boolean | null => {
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
	};

	fs.writeFileSync(`${__dirname}/openapi-docs.json`, JSON.stringify(docs, replacer, 4), {
		encoding: 'utf-8',
	});
}

const docs = generateOpenAPI();
writeDocumentation(docs);
