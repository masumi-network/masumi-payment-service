import type { ReportExportKind } from '@/lib/transaction-report/download';

/** The three CSV files. The ZIP is not a fourth file, it is all three at once. */
export type ReportCsvKind = Exclude<ReportExportKind, 'zip'>;

/**
 * What each downloadable file actually contains.
 *
 * A CSV is invisible until it is open in a spreadsheet, and these three files
 * differ only in how far the numbers are already added up. Naming the row and
 * showing a shortened real row lets an operator pick the right file once
 * instead of downloading all three to find out.
 */
export type ReportExportKindOption = Readonly<{
  value: ReportCsvKind;
  label: string;
  /** What one row of the file stands for. */
  rowMeaning: string;
  /** When this file is the right pick. */
  useFor: string;
  /**
   * A shortened real row. Money is split by asset, because that is how the
   * file writes it: one column per asset, never a converted total.
   */
  example: Readonly<{
    facts: ReadonlyArray<readonly [string, string]>;
    assets: readonly string[];
    amounts: ReadonlyArray<Readonly<{ label: string; values: readonly string[] }>>;
  }>;
}>;

export const REPORT_EXPORT_KINDS: readonly ReportExportKindOption[] = [
  {
    value: 'transactions',
    label: 'Transactions',
    rowMeaning: 'One row per request, per side.',
    useFor: 'Bookkeeping line items and audits. Carries the on-chain transaction hashes.',
    example: {
      facts: [
        ['Side', 'Selling'],
        ['State', 'Result submitted'],
        ['Result tx hash', 'Included'],
      ],
      assets: ['ADA', 'USDM'],
      amounts: [
        { label: 'Gross revenue', values: ['40.00', '200.00'] },
        { label: 'Protocol fee', values: ['2.25', '10.00'] },
        { label: 'Network fee', values: ['0.15', '0.00'] },
        { label: 'Net revenue', values: ['37.60', '190.00'] },
      ],
    },
  },
  {
    value: 'wallet-summary',
    label: 'Wallet summary',
    rowMeaning: 'One row per managed wallet and role.',
    useFor: 'Splitting income and spend across wallets.',
    example: {
      facts: [
        ['Wallet', 'Selling wallet A'],
        ['Side', 'Selling'],
        ['Requests', '2'],
      ],
      assets: ['ADA', 'USDM'],
      amounts: [
        { label: 'Gross revenue', values: ['140.00', '200.00'] },
        { label: 'Protocol fees', values: ['7.50', '10.00'] },
        { label: 'Network fees', values: ['0.55', '0.00'] },
        { label: 'Net revenue', values: ['131.95', '190.00'] },
      ],
    },
  },
  {
    value: 'totals',
    label: 'Totals',
    rowMeaning: 'A single row for the whole period.',
    useFor: 'One figure per metric, ready to paste.',
    example: {
      facts: [
        ['Requests', '8'],
        ['Estimated figures', 'Protocol fees'],
      ],
      assets: ['ADA', 'USDM'],
      amounts: [
        { label: 'Gross revenue', values: ['390.00', '200.00'] },
        { label: 'Protocol fees', values: ['20.25', '10.00'] },
        { label: 'Net revenue', values: ['368.70', '190.00'] },
        { label: 'Net spend', values: ['155.83', '50.00'] },
      ],
    },
  },
] as const;

export const REPORT_CSV_KINDS: readonly ReportCsvKind[] = REPORT_EXPORT_KINDS.map(
  (kind) => kind.value,
);

export function isEveryReportCsvKind(kinds: readonly ReportCsvKind[]): boolean {
  return REPORT_CSV_KINDS.every((kind) => kinds.includes(kind));
}
