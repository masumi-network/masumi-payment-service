import { generateOpenAPI } from '.';
import { writeOpenAPIDocument } from './openapi-serialization';

export function writeDocumentation(docs: unknown) {
	writeOpenAPIDocument(docs);
}

const docs = generateOpenAPI();
writeDocumentation(docs);
