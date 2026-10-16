import assert from 'node:assert/strict';
import test from 'node:test';
import type { GetReportsFacetsResponses, PostReportsSummaryData } from '@/lib/api/generated';
import {
  getCurrentFinancialReportExportError,
  getFinancialReportErrorMessage,
  isCurrentFinancialReportBody,
  resolveFinancialReportSource,
} from './useFinancialReportModel';

type ReportSource = GetReportsFacetsResponses[200]['data']['paymentSources'][number];

function source(
  id: string,
  network: ReportSource['network'],
  deletedAt: Date | null = null,
): ReportSource {
  return {
    id,
    network,
    paymentSourceType: 'Web3CardanoV2',
    feeRatePermille: 50,
    smartContractAddress: `addr_${id}`,
    deletedAt,
  };
}

test('report source selection keeps archived choices and stays on the active network', () => {
  const archived = source('archived', 'Preprod', new Date('2026-01-01T00:00:00.000Z'));
  const result = resolveFinancialReportSource(
    [archived, source('mainnet', 'Mainnet'), source('active', 'Preprod')],
    'Preprod',
    'archived',
    'active',
  );

  assert.deepEqual(
    result.paymentSources.map((paymentSource) => paymentSource.id),
    ['active', 'archived'],
  );
  assert.equal(result.effectivePaymentSourceId, 'archived');
});

test('report source selection prefers the dashboard source before the first accessible fallback', () => {
  const paymentSources = [source('first', 'Preprod'), source('selected', 'Preprod')];

  assert.equal(
    resolveFinancialReportSource(paymentSources, 'Preprod', 'missing', 'selected')
      .effectivePaymentSourceId,
    'selected',
  );
  assert.equal(
    resolveFinancialReportSource(paymentSources, 'Preprod', 'missing', 'also-missing')
      .effectivePaymentSourceId,
    'first',
  );
});

test('report errors preserve server text and add bounded-query guidance', () => {
  const serverLimit = 'Report exceeds the 50,000 row limit.';
  const serverTimeout = 'Report calculation timed out.';

  assert.equal(
    getFinancialReportErrorMessage({ error: { message: serverLimit } }, 'fallback', 413),
    `${serverLimit} Use a shorter period or select fewer wallets, roles, or states.`,
  );
  assert.equal(
    getFinancialReportErrorMessage(new Error(serverTimeout), 'fallback', 504),
    `${serverTimeout} Use a shorter period or narrower filters, then try again.`,
  );
  assert.equal(
    getFinancialReportErrorMessage(
      new Error('Report exceeds 50000 rows. Narrow the report filters.'),
      'fallback',
    ),
    'Report exceeds 50000 rows. Narrow the report filters. Use a shorter period or select fewer wallets, roles, or states.',
  );
});

test('summary data is current once the visible filters reach the debounce', () => {
  const visibleBody: PostReportsSummaryData['body'] = {
    paymentSourceId: 'source-1',
    from: new Date('2026-07-25T12:00:00.000Z'),
    to: new Date('2026-08-24T12:00:00.000Z'),
  };

  // A rebuilt body with the same filters is the same report. Comparing by
  // identity blanked the dashboard after every facets refetch.
  assert.equal(isCurrentFinancialReportBody(visibleBody, { ...visibleBody }), true);
  assert.equal(isCurrentFinancialReportBody(visibleBody, visibleBody), true);
  assert.equal(isCurrentFinancialReportBody(null, visibleBody), false);
  assert.equal(
    isCurrentFinancialReportBody(visibleBody, { ...visibleBody, paymentSourceId: 'source-2' }),
    false,
  );
});

test('an export error is hidden as soon as the visible report body changes', () => {
  const attemptedBody: PostReportsSummaryData['body'] = {
    paymentSourceId: 'source-1',
    from: new Date('2026-07-25T12:00:00.000Z'),
    to: new Date('2026-08-24T12:00:00.000Z'),
  };
  const error = new Error('Report exceeds the row limit.');

  assert.equal(getCurrentFinancialReportExportError(error, attemptedBody, attemptedBody), error);
  assert.equal(
    getCurrentFinancialReportExportError(
      error,
      { ...attemptedBody, paymentSourceId: 'source-2' },
      attemptedBody,
    ),
    null,
  );
});
