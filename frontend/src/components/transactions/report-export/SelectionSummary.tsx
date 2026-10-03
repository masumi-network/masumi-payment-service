import {
  REPORT_DATE_BASIS_LABELS,
  REPORT_DATE_PRESET_LABELS,
  REPORT_REVENUE_MODE_LABELS,
} from '@/lib/transaction-report/report-labels';
import { formatCalendarDisplay } from '@/lib/date-picker-calendar';
import { NO_FIAT_CURRENCY } from '@/lib/transaction-report/fiat-settings';
import type { useDownloadDetailsModel } from '../useDownloadDetailsModel';
import { REPORT_EXPORT_KINDS } from './export-kinds';
import { reportPurposeShows } from './report-purposes';

type ReportModel = ReturnType<typeof useDownloadDetailsModel>;

function counted(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function sidesLabel(roles: ReportModel['form']['roles']): string {
  const hasSeller = roles.includes('Seller');
  const hasBuyer = roles.includes('Buyer');
  if (hasSeller && hasBuyer) return 'Selling and buying';
  if (hasSeller) return 'Selling only';
  if (hasBuyer) return 'Buying only';
  return 'No side picked';
}

/** Names every choice that is currently in force, including the hidden ones. */
export function buildReportSelectionChips(model: ReportModel): string[] {
  const { form } = model;
  const period =
    form.datePreset === 'custom' && form.customStartDate && form.customEndDate
      ? `${formatCalendarDisplay(form.customStartDate) ?? form.customStartDate} to ${
          formatCalendarDisplay(form.customEndDate) ?? form.customEndDate
        }`
      : REPORT_DATE_PRESET_LABELS[form.datePreset];

  const files = REPORT_EXPORT_KINDS.filter((kind) => model.exportKinds.includes(kind.value)).map(
    (kind) => kind.label,
  );

  return [
    period,
    sidesLabel(form.roles),
    form.managedWalletIds.length > 0
      ? counted(form.managedWalletIds.length, 'wallet', 'wallets')
      : null,
    form.states.length > 0 ? counted(form.states.length, 'state', 'states') : null,
    form.externalAddressesText.trim()
      ? counted(
          form.externalAddressesText
            .trim()
            .split(/[\s,]+/)
            .filter(Boolean).length,
          'address',
          'addresses',
        )
      : null,
    reportPurposeShows(model.purpose, 'rules')
      ? `${REPORT_REVENUE_MODE_LABELS[form.revenueMode]}, ${REPORT_DATE_BASIS_LABELS[
          form.dateBasis
        ].toLowerCase()}`
      : null,
    form.fiatCurrency === NO_FIAT_CURRENCY
      ? null
      : `Converted to ${form.fiatCurrency.toUpperCase()}`,
    files.length > 0 ? files.join(' + ') : 'No file picked',
  ].filter((chip): chip is string => chip != null);
}

/**
 * A running answer to "what am I about to download?".
 *
 * The dialog is taller than the screen, so the choices made three sections ago
 * would otherwise be out of sight at the moment of pressing Download.
 */
export function SelectionSummary({ model }: Readonly<{ model: ReportModel }>) {
  const chips = buildReportSelectionChips(model);

  return (
    <ul className="flex flex-wrap items-center gap-1.5">
      {chips.map((chip) => (
        <li
          key={chip}
          className="rounded-full border bg-muted/30 px-2.5 py-0.5 text-[11px] text-muted-foreground"
        >
          {chip}
        </li>
      ))}
    </ul>
  );
}
