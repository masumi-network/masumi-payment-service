import {
  collectReportAssetUnits,
  getReportAssetDescriptor,
} from '@/lib/transaction-report/dashboard-metrics';
import { NO_FIAT_CURRENCY } from '@/lib/transaction-report/fiat-settings';
import { shortenAddress } from '@/lib/utils';
import type { useDownloadDetailsModel } from '../useDownloadDetailsModel';

type ReportModel = ReturnType<typeof useDownloadDetailsModel>;

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * Says which assets the file will hold, and whether any of them is converted.
 *
 * Every money column exists once per asset, so a period with ADA and a
 * stablecoin produces two columns per figure. Without a currency picked no
 * exchange rate is applied, and a reader who assumes one would add unlike
 * units together.
 */
export function ExportAssetNote({ model }: Readonly<{ model: ReportModel }>) {
  const summary = model.preview;
  const assetNames = summary
    ? collectReportAssetUnits(summary)
        .filter((unit) => !unit.startsWith('fiat:'))
        .map((unit) => getReportAssetDescriptor(summary, unit).symbol ?? shortenAddress(unit, 6))
    : [];
  const currency =
    model.form.fiatCurrency === NO_FIAT_CURRENCY ? null : model.form.fiatCurrency.toUpperCase();

  return (
    <p className="text-[11px] text-muted-foreground">
      Every money figure gets one column per asset, such as{' '}
      <span className="font-mono">seller_gross_revenue_ada</span> and{' '}
      <span className="font-mono">seller_gross_revenue_usdm</span>, plus a JSON column for any other
      token.{' '}
      {assetNames.length > 0
        ? `This period holds ${joinNames(assetNames)}.`
        : 'The columns exist even when a period holds only one asset.'}{' '}
      Amounts stay in their own asset.{' '}
      {currency == null ? (
        <>The report applies no exchange rate, so do not add ADA and a stablecoin together.</>
      ) : (
        <>
          Each figure also gets a <span className="font-mono">_fiat</span> column holding the same
          money in {currency}, so one column can be added up across assets.
        </>
      )}
    </p>
  );
}
