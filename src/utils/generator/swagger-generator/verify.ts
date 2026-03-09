import { generateOpenAPI } from '.';
import {
	OPENAPI_BASELINE_HASH,
	hashOpenAPIDocument,
	readCheckedInOpenAPIDocument,
	serializeOpenAPIDocument,
} from './openapi-serialization';

const docs = generateOpenAPI();
const generatedDocument = serializeOpenAPIDocument(docs);
const generatedHash = hashOpenAPIDocument(generatedDocument);
const checkedInDocument = readCheckedInOpenAPIDocument();
const checkedInHash = hashOpenAPIDocument(checkedInDocument);

if (checkedInHash !== OPENAPI_BASELINE_HASH) {
	throw new Error(
		`Checked-in OpenAPI hash changed unexpectedly. Expected ${OPENAPI_BASELINE_HASH}, received ${checkedInHash}.`,
	);
}

if (generatedDocument !== checkedInDocument) {
	throw new Error(
		`Generated OpenAPI document diverged from checked-in snapshot. Expected hash ${checkedInHash}, received ${generatedHash}.`,
	);
}

console.log(
	JSON.stringify({
		bytes: generatedDocument.length,
		sha256: generatedHash,
	}),
);
