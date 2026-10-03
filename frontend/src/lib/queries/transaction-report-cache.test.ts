import assert from 'node:assert/strict';
import test from 'node:test';
import { QueryClient } from '@tanstack/react-query';
import {
  invalidateTransactionReportFacets,
  TRANSACTION_REPORT_FACETS_QUERY_KEY,
} from './transaction-report-cache';

test('report facet invalidation marks the shared query stale after source or wallet changes', async () => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(TRANSACTION_REPORT_FACETS_QUERY_KEY, { paymentSources: [] });

  await invalidateTransactionReportFacets(queryClient);

  assert.equal(queryClient.getQueryState(TRANSACTION_REPORT_FACETS_QUERY_KEY)?.isInvalidated, true);
});
