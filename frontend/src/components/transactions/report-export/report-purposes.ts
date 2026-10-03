import type { TransactionReportFormState } from '../download-details.helpers';
import type { ReportCsvKind } from './export-kinds';

/**
 * Export flows, named after the job an operator came to do.
 *
 * The report has more filters and accounting rules than any single job needs,
 * and a filter that is set but never seen changes the numbers silently. So a
 * flow decides which fields are on screen, and every field a flow hides is
 * reset to its neutral value: what you cannot see cannot narrow your file.
 */
export type ReportPurpose = 'accounting' | 'wallets' | 'investigate' | 'totals' | 'custom';

export type ReportPurposeField = 'sides' | 'wallets' | 'states' | 'addresses' | 'rules';

export type ReportPurposeOption = Readonly<{
  value: ReportPurpose;
  label: string;
  detail: string;
  /** Fields this flow puts on screen. Everything else is reset and hidden. */
  fields: readonly ReportPurposeField[];
  /** Files this flow selects when it is picked. */
  files: readonly ReportCsvKind[];
}>;

export const REPORT_PURPOSES: Readonly<Record<ReportPurpose, ReportPurposeOption>> = {
  accounting: {
    value: 'accounting',
    label: 'Close a period',
    detail: 'Everything in a period, ready for the books.',
    fields: ['sides', 'rules'],
    files: ['transactions', 'wallet-summary', 'totals'],
  },
  wallets: {
    value: 'wallets',
    label: 'Reconcile wallets',
    detail: 'Income and spend split per managed wallet.',
    fields: ['sides', 'wallets'],
    files: ['wallet-summary', 'transactions'],
  },
  investigate: {
    value: 'investigate',
    label: 'Investigate requests',
    detail: 'Chase specific states or counterparty addresses.',
    fields: ['sides', 'states', 'addresses'],
    files: ['transactions'],
  },
  totals: {
    value: 'totals',
    label: 'Get period totals',
    detail: 'One figure per metric, nothing else.',
    fields: ['sides'],
    files: ['totals'],
  },
  custom: {
    value: 'custom',
    label: 'Custom',
    detail: 'Every filter and accounting rule.',
    fields: ['sides', 'wallets', 'states', 'addresses', 'rules'],
    files: ['transactions'],
  },
};

/** The four flows offered as cards. Custom is reached from a link instead. */
export const REPORT_PURPOSE_CARDS: readonly ReportPurposeOption[] = [
  REPORT_PURPOSES.accounting,
  REPORT_PURPOSES.wallets,
  REPORT_PURPOSES.investigate,
  REPORT_PURPOSES.totals,
];

export function reportPurposeShows(purpose: ReportPurpose, field: ReportPurposeField): boolean {
  return REPORT_PURPOSES[purpose].fields.includes(field);
}

/** Clears every filter and rule the flow does not show. */
export function applyReportPurpose(
  form: TransactionReportFormState,
  purpose: ReportPurpose,
): TransactionReportFormState {
  return {
    ...form,
    managedWalletIds: reportPurposeShows(purpose, 'wallets') ? form.managedWalletIds : [],
    states: reportPurposeShows(purpose, 'states') ? form.states : [],
    externalAddressesText: reportPurposeShows(purpose, 'addresses')
      ? form.externalAddressesText
      : '',
    dateBasis: reportPurposeShows(purpose, 'rules') ? form.dateBasis : 'RevenueRecognizedAt',
    revenueMode: reportPurposeShows(purpose, 'rules') ? form.revenueMode : 'Billable',
  };
}

/**
 * Picks the flow that keeps what the caller already filtered by. Opening the
 * export from a filtered list must not drop that filter on the first render.
 */
export function inferReportPurpose(form: TransactionReportFormState): ReportPurpose {
  if (form.states.length > 0 || form.externalAddressesText.trim()) return 'investigate';
  if (form.managedWalletIds.length > 0) return 'wallets';
  return 'accounting';
}
