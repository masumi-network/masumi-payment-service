import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApiKeyTableSkeleton } from './ApiKeyTableSkeleton';

test('API-key loading rows match the seven table columns', () => {
  const html = renderToStaticMarkup(createElement(ApiKeyTableSkeleton, { rows: 2 }));
  const rows = html.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/g) ?? [];

  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal((row.match(/<td\b/g) ?? []).length, 7);
  }
});
