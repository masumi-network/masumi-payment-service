import assert from 'node:assert/strict';
import test from 'node:test';
import {
  patchReportExportResponseTypes,
  REPORT_CSV_EXPORT_OPERATION_NAMES,
} from '../../../scripts/patch-report-export-response-types';

function generatedOperation(name: string, responseType: 'blob' | 'text'): string {
  return `export const ${name} = () => client.post({\n    responseType: '${responseType}',\n});`;
}

test('generated report CSV operations use Blob response mode', () => {
  const generated = REPORT_CSV_EXPORT_OPERATION_NAMES.map((name) =>
    generatedOperation(name, 'text'),
  ).join('\n');
  const patched = patchReportExportResponseTypes(generated);

  for (const name of REPORT_CSV_EXPORT_OPERATION_NAMES) {
    assert.ok(patched.includes(generatedOperation(name, 'blob')));
  }
  assert.equal(patchReportExportResponseTypes(patched), patched);
});

test('generated response patch fails when an expected operation shape changes', () => {
  assert.throws(
    () =>
      patchReportExportResponseTypes(
        'export const postReportsTransactionsCsv = () => client.post({\n});',
      ),
    /postReportsTransactionsCsv response type was not found/,
  );
});
