import {
  postReportsExportZip,
  postReportsTotalsCsv,
  postReportsTransactionsCsv,
  postReportsWalletSummaryCsv,
  type PostReportsSummaryData,
} from '@/lib/api/generated';
import type { Client } from '@/lib/api/generated/client';
import { extractApiErrorMessage } from '@/lib/api-error';
import { getOwnValue, isObject } from '@/lib/object-properties';

export type ReportExportKind = 'transactions' | 'wallet-summary' | 'totals' | 'zip';

const FALLBACK_FILENAMES: Record<ReportExportKind, string> = {
  transactions: 'transactions.csv',
  'wallet-summary': 'wallet-summary.csv',
  totals: 'totals.csv',
  zip: 'transaction-report.zip',
};

const INVALID_FILENAME_CHARACTER = /[\u0000-\u001f\u007f/\\]/u;
const MAX_FILENAME_LENGTH = 255;

function safeFilename(value: string): string | null {
  const filename = value.trim();
  if (
    filename.length === 0 ||
    filename.length > MAX_FILENAME_LENGTH ||
    filename === '.' ||
    filename === '..' ||
    INVALID_FILENAME_CHARACTER.test(filename)
  ) {
    return null;
  }
  return filename;
}

function filenameFromContentDisposition(header: string | undefined, fallback: string): string {
  if (!header) return fallback;

  const encodedMatch = /(?:^|;)\s*filename\*\s*=\s*UTF-8'[^']*'([^;]*)/iu.exec(header);
  if (encodedMatch) {
    try {
      const decoded = safeFilename(decodeURIComponent(encodedMatch[1].trim()));
      if (decoded) return decoded;
    } catch {
      // Use the quoted filename or fixed fallback below.
    }
  }

  const quotedMatch = /(?:^|;)\s*filename\s*=\s*"((?:[^"\\]|\\.)*)"/iu.exec(header);
  const quoted = quotedMatch?.[1].replace(/\\(["\\])/gu, '$1');
  return (quoted && safeFilename(quoted)) || fallback;
}

async function decodeErrorPayload(error: unknown): Promise<unknown> {
  if (!isObject(error)) return error;
  const response = getOwnValue(error, 'response');
  if (!isObject(response)) return error;
  const data = getOwnValue(response, 'data');
  if (!(data instanceof Blob)) return data ?? error;

  try {
    const text = await data.text();
    if (!text) return error;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  } catch {
    return error;
  }
}

async function requestReportExport({
  client,
  body,
  kind,
}: {
  client: Client;
  body: PostReportsSummaryData['body'];
  kind: ReportExportKind;
}) {
  const options = {
    client,
    body,
    responseType: 'blob' as const,
    throwOnError: true as const,
  };

  switch (kind) {
    case 'transactions':
      return postReportsTransactionsCsv(options);
    case 'wallet-summary':
      return postReportsWalletSummaryCsv(options);
    case 'totals':
      return postReportsTotalsCsv(options);
    case 'zip':
      return postReportsExportZip(options);
  }
}

export async function fetchTransactionReportExport({
  client,
  body,
  kind,
}: {
  client: Client;
  body: PostReportsSummaryData['body'];
  kind: ReportExportKind;
}): Promise<{ blob: Blob; filename: string }> {
  try {
    const response = await requestReportExport({ client, body, kind });
    if (!(response.data instanceof Blob)) {
      throw new Error('Report export returned an invalid binary response');
    }

    const contentDisposition = response.headers['content-disposition'];
    return {
      blob: response.data,
      filename: filenameFromContentDisposition(
        typeof contentDisposition === 'string' ? contentDisposition : undefined,
        FALLBACK_FILENAMES[kind],
      ),
    };
  } catch (error) {
    const payload = await decodeErrorPayload(error);
    throw new Error(extractApiErrorMessage(payload, 'Failed to export transaction report'));
  }
}

export function saveTransactionReportExport({
  blob,
  filename,
}: {
  blob: Blob;
  filename: string;
}): void {
  const objectUrl = URL.createObjectURL(blob);
  let link: HTMLAnchorElement | undefined;
  try {
    link = document.createElement('a');
    link.href = objectUrl;
    link.download = safeFilename(filename) ?? 'transaction-report-download';
    document.body.appendChild(link);
    link.click();
  } finally {
    link?.remove();
    URL.revokeObjectURL(objectUrl);
  }
}
