import assert from 'node:assert/strict';
import test from 'node:test';
import { extractApiErrorMessage } from './api-error';

test('extractApiErrorMessage returns a top-level string error field', () => {
  assert.equal(
    extractApiErrorMessage({ error: 'Purchase already exists' }, 'HTTP 400: Bad Request'),
    'Purchase already exists',
  );
});

test('extractApiErrorMessage still prioritizes top-level message over top-level error', () => {
  assert.equal(
    extractApiErrorMessage(
      { message: 'Validation failed', error: 'Purchase already exists' },
      'HTTP 400: Bad Request',
    ),
    'Validation failed',
  );
});
