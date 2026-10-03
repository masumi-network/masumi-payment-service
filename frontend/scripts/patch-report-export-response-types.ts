import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const REPORT_CSV_EXPORT_OPERATION_NAMES = [
  'postReportsTransactionsCsv',
  'postReportsWalletSummaryCsv',
  'postReportsTotalsCsv',
] as const;

export function patchReportExportResponseTypes(source: string): string {
  let patched = source;

  for (const operationName of REPORT_CSV_EXPORT_OPERATION_NAMES) {
    const operationStart = patched.indexOf(`export const ${operationName} =`);
    if (operationStart < 0) throw new Error(`${operationName} operation was not found`);
    const operationEnd = patched.indexOf('\n});', operationStart);
    if (operationEnd < 0) throw new Error(`${operationName} operation end was not found`);

    const blockEnd = operationEnd + '\n});'.length;
    const operationBlock = patched.slice(operationStart, blockEnd);
    if (operationBlock.includes("responseType: 'blob'")) continue;
    if (!operationBlock.includes("responseType: 'text'")) {
      throw new Error(`${operationName} response type was not found`);
    }

    patched =
      patched.slice(0, operationStart) +
      operationBlock.replace("responseType: 'text'", "responseType: 'blob'") +
      patched.slice(blockEnd);
  }

  return patched;
}

async function patchGeneratedSdk(): Promise<void> {
  const sdkUrl = new URL('../src/lib/api/generated/sdk.gen.ts', import.meta.url);
  const source = await readFile(sdkUrl, 'utf8');
  const patched = patchReportExportResponseTypes(source);
  if (patched !== source) await writeFile(sdkUrl, patched, 'utf8');
}

const entryUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entryUrl === import.meta.url) await patchGeneratedSdk();
