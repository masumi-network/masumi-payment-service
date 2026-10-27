import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import type * as SchemaValidator from 'masumi-schema-validator-component';

const componentRequire = createRequire(import.meta.url);
const { validateSchemaWithZod } = componentRequire(
  'masumi-schema-validator-component',
) as typeof SchemaValidator;

test('malformed schema returns a short validation error with Zod 4', () => {
  const result = validateSchemaWithZod(
    JSON.stringify({
      id: 'name',
      type: 'text',
      name: 'Name',
      validations: [{ validation: 'unknown' }],
    }),
  );

  assert.equal(result.valid, false);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /^Schema 1:/);
  assert.ok(result.errors[0].message.length < 500);
});
