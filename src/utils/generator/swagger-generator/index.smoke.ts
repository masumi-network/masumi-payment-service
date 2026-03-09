import assert from 'node:assert/strict';
import test from 'node:test';

void test('generateOpenAPI is stable across repeated calls and matches the checked-in document', async () => {
	process.env.DATABASE_URL ??= 'postgresql://test@localhost:5432/masumi_payment_service';
	process.env.ENCRYPTION_KEY ??= 'set-mock-enc-key-for-generation';

	const { generateOpenAPI } = await import('./index.js');
	const { readCheckedInOpenAPIDocument, serializeOpenAPIDocument } = await import('./openapi-serialization.js');

	const firstDocument = serializeOpenAPIDocument(generateOpenAPI());
	const secondDocument = serializeOpenAPIDocument(generateOpenAPI());

	assert.equal(firstDocument, readCheckedInOpenAPIDocument());
	assert.equal(secondDocument, firstDocument);
});
