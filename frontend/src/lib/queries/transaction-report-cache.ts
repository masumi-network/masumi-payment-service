import type { QueryClient } from '@tanstack/react-query';

export const TRANSACTION_REPORT_FACETS_QUERY_KEY = ['transaction-report-facets'] as const;

export function invalidateTransactionReportFacets(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: TRANSACTION_REPORT_FACETS_QUERY_KEY });
}
