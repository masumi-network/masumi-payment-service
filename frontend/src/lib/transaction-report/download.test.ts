import assert from 'node:assert/strict';
import test from 'node:test';
import type { Client } from '@/lib/api/generated/client';
import type { PostReportsSummaryData } from '@/lib/api/generated';
import {
  fetchTransactionReportExport,
  OBJECT_URL_RELEASE_DELAY_MS,
  saveTransactionReportExport,
  type ReportExportKind,
} from './download';

type CapturedRequest = {
  body?: unknown;
  responseType?: string;
  throwOnError?: boolean;
  url?: string;
};

const reportBody: PostReportsSummaryData['body'] = {
  paymentSourceId: 'source-1',
  from: new Date('2026-01-01T00:00:00.000Z'),
  to: new Date('2026-02-01T00:00:00.000Z'),
};

function createClient(handler: (request: CapturedRequest) => Promise<unknown>): Client {
  return { post: handler } as unknown as Client;
}

test('report exports use the authenticated client with binary response mode', async () => {
  const expectedPaths: Record<ReportExportKind, string> = {
    transactions: '/reports/transactions.csv',
    'wallet-summary': '/reports/wallet-summary.csv',
    totals: '/reports/totals.csv',
    zip: '/reports/export.zip',
  };

  for (const [kind, expectedPath] of Object.entries(expectedPaths) as Array<
    [ReportExportKind, string]
  >) {
    let capturedRequest: CapturedRequest | undefined;
    const blob = new Blob([kind]);
    const client = createClient(async (request) => {
      capturedRequest = request;
      return {
        data: blob,
        headers: {
          'content-disposition':
            'attachment; filename="masumi-report.csv"; filename*=UTF-8\'\'m%C3%A4sumi-report.csv',
        },
      };
    });

    const result = await fetchTransactionReportExport({ client, body: reportBody, kind });

    assert.equal(capturedRequest?.url, expectedPath);
    assert.equal(capturedRequest?.responseType, 'blob');
    assert.equal(capturedRequest?.throwOnError, true);
    assert.equal(capturedRequest?.body, reportBody);
    assert.equal(result.blob, blob);
    assert.equal(result.filename, 'mäsumi-report.csv');
  }
});

test('report export filenames fall back from unsafe RFC 5987 values to quoted names', async () => {
  const blob = new Blob(['csv']);
  const client = createClient(async () => ({
    data: blob,
    headers: {
      'content-disposition':
        'attachment; filename="safe-report.csv"; filename*=UTF-8\'\'..%2Funsafe.csv',
    },
  }));

  const result = await fetchTransactionReportExport({
    client,
    body: reportBody,
    kind: 'transactions',
  });

  assert.equal(result.filename, 'safe-report.csv');
});

test('report exports use a safe kind-specific filename when the header is missing', async () => {
  const client = createClient(async () => ({ data: new Blob(['csv']), headers: {} }));

  const result = await fetchTransactionReportExport({ client, body: reportBody, kind: 'totals' });

  assert.equal(result.filename, 'totals.csv');
});

test('report exports decode JSON error blobs without losing the server message', async () => {
  const message = 'Report CSV exceeds 67108864 bytes. Narrow the report filters.';
  const client = createClient(async () => {
    throw Object.assign(new Error('Request failed with status code 413'), {
      response: {
        data: new Blob([JSON.stringify({ status: 'error', error: { message } })], {
          type: 'application/json',
        }),
      },
    });
  });

  await assert.rejects(fetchTransactionReportExport({ client, body: reportBody, kind: 'zip' }), {
    message,
  });
});

test('saveTransactionReportExport always releases its URL when the browser click fails', () => {
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const createObjectUrlDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
  const revokeObjectUrlDescriptor = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
  let clicked = false;
  let removed = false;
  let revokedUrl: string | undefined;
  const anchor = {
    href: '',
    download: '',
    click: () => {
      clicked = true;
      throw new Error('click failed');
    },
    remove: () => {
      removed = true;
    },
  };

  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: () => anchor,
      body: { appendChild: () => anchor },
    },
  });
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: () => 'blob:report',
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: (url: string) => {
      revokedUrl = url;
    },
  });

  try {
    assert.throws(
      () =>
        saveTransactionReportExport({
          blob: new Blob(['csv']),
          filename: 'masumi-transactions.csv',
        }),
      { message: 'click failed' },
    );

    assert.equal(anchor.href, 'blob:report');
    assert.equal(anchor.download, 'masumi-transactions.csv');
    assert.equal(clicked, true);
    assert.equal(removed, true);
    assert.equal(revokedUrl, 'blob:report');
  } finally {
    if (documentDescriptor) {
      Object.defineProperty(globalThis, 'document', documentDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, 'document');
    }
    if (createObjectUrlDescriptor) {
      Object.defineProperty(URL, 'createObjectURL', createObjectUrlDescriptor);
    } else {
      Reflect.deleteProperty(URL, 'createObjectURL');
    }
    if (revokeObjectUrlDescriptor) {
      Object.defineProperty(URL, 'revokeObjectURL', revokeObjectUrlDescriptor);
    } else {
      Reflect.deleteProperty(URL, 'revokeObjectURL');
    }
  }
});

test('saveTransactionReportExport keeps its URL alive until the download has started', async () => {
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const createObjectUrlDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
  const revokeObjectUrlDescriptor = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
  let revokedUrl: string | undefined;
  const anchor = { href: '', download: '', click: () => {}, remove: () => {} };

  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { createElement: () => anchor, body: { appendChild: () => anchor } },
  });
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: () => 'blob:report',
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: (url: string) => {
      revokedUrl = url;
    },
  });

  try {
    saveTransactionReportExport({ blob: new Blob(['csv']), filename: 'masumi-transactions.csv' });

    // Revoking here is what cancels the download in the browsers that read the
    // blob after the click returns.
    assert.equal(revokedUrl, undefined);

    await new Promise((resolve) => setTimeout(resolve, OBJECT_URL_RELEASE_DELAY_MS + 50));
    assert.equal(revokedUrl, 'blob:report');
  } finally {
    if (documentDescriptor) {
      Object.defineProperty(globalThis, 'document', documentDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, 'document');
    }
    if (createObjectUrlDescriptor) {
      Object.defineProperty(URL, 'createObjectURL', createObjectUrlDescriptor);
    } else {
      Reflect.deleteProperty(URL, 'createObjectURL');
    }
    if (revokeObjectUrlDescriptor) {
      Object.defineProperty(URL, 'revokeObjectURL', revokeObjectUrlDescriptor);
    } else {
      Reflect.deleteProperty(URL, 'revokeObjectURL');
    }
  }
});
