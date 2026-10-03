import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReportTablePagination } from './ReportTablePagination';

test('chart pagers expose unique title-specific navigation landmarks', () => {
  const sharedProps = {
    page: 0,
    pageCount: 2,
    startIndex: 0,
    endIndex: 50,
    totalCount: 100,
    itemLabel: 'history rows',
    onPageChange: () => {},
  };
  const markup = renderToStaticMarkup(
    createElement(
      'div',
      null,
      createElement(ReportTablePagination, {
        ...sharedProps,
        ariaLabel: 'Value history chart data pagination',
      }),
      createElement(ReportTablePagination, {
        ...sharedProps,
        ariaLabel: 'Cardano fee history chart data pagination',
      }),
    ),
  );

  assert.match(markup, /aria-label="Value history chart data pagination"/u);
  assert.match(markup, /aria-label="Cardano fee history chart data pagination"/u);
  assert.doesNotMatch(markup, /aria-label="history rows pagination"/u);
});
