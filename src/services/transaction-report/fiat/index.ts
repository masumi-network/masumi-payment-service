import { REPORT_FIAT_CURRENCIES, REPORT_FIAT_MODES } from '@/routes/api/reports/schemas';
import { normalizeAssetUnit } from '@/utils/asset-units';
import type { ReportMetricWindow, ReportRow } from '../records';
import { applyFiatToReportRows, type FiatWindow } from './apply';
import {
	DEMO_HISTORY_DAYS,
	fetchDailyFiatRates,
	getCoinId,
	getEarliestPriceableDate,
	isFiatRateProviderConfigured,
	isFiatRateProviderDemo,
} from './coingecko';
import { createFiatRateTable, type FiatRateMode, type SuppliedFiatRate } from './rates';

export {
	assertPriceableRange,
	DEMO_HISTORY_DAYS,
	getEarliestPriceableDate,
	isFiatRateProviderConfigured,
	isFiatRateProviderDemo,
} from './coingecko';
export type { FiatRateMode } from './rates';

export const COINGECKO_ATTRIBUTION = 'Exchange rates by CoinGecko';

export type ReportFiatInput = Readonly<{
	currency: string;
	mode: FiatRateMode;
	suppliedRates?: readonly SuppliedFiatRate[];
}>;

export type ReportFiatMetadata = Readonly<{
	currency: string;
	mode: FiatRateMode;
	provider: 'coingecko' | 'supplied';
	attribution: string | null;
	isDemoKey: boolean;
	demoHistoryDays: number | null;
	completeness: 'complete' | 'partial';
	/** Units the report holds that no rate covers. Their money has no fiat figure. */
	unpricedUnits: string[];
}>;

function collectReportUnits(rows: readonly ReportRow[]): string[] {
	const units = new Set<string>(['lovelace']);
	for (const row of rows) {
		for (const group of [row.requestedFunds, row.withdrawnForBuyer, row.withdrawnForSeller]) {
			for (const amount of group) units.add(normalizeAssetUnit(amount.unit));
		}
	}
	return [...units];
}

/**
 * Converts a report into one fiat currency.
 *
 * Rates the caller supplied win over fetched ones, and a unit with no rate at
 * all leaves its figures unconverted rather than counted as zero.
 */
export async function applyReportFiat(
	rows: readonly ReportRow[],
	fiat: ReportFiatInput,
	window: FiatWindow,
	dateBasis: ReportMetricWindow['dateBasis'],
): Promise<Readonly<{ rows: ReportRow[]; metadata: ReportFiatMetadata }>> {
	const supplied = fiat.suppliedRates ?? [];
	const suppliedUnits = new Set(supplied.map((rate) => normalizeAssetUnit(rate.unit)));
	const reportUnits = collectReportUnits(rows);
	const fetchUnits = reportUnits.filter((unit) => !suppliedUnits.has(unit));
	const needsProvider = fetchUnits.some((unit) => getCoinId(unit) != null);

	const fetched = needsProvider
		? await fetchDailyFiatRates({ units: fetchUnits, currency: fiat.currency, from: window.from, to: window.to })
		: { daily: new Map<string, Map<string, string>>(), unsupportedUnits: [] as readonly string[] };

	const table = createFiatRateTable({
		currency: fiat.currency,
		mode: fiat.mode,
		supplied,
		daily: fetched.daily,
	});
	const applied = applyFiatToReportRows(rows, table, dateBasis, window);
	const isDemoKey = needsProvider && isFiatRateProviderDemo();

	return {
		rows: applied.rows,
		metadata: {
			currency: fiat.currency,
			mode: fiat.mode,
			provider: needsProvider ? 'coingecko' : 'supplied',
			attribution: needsProvider ? COINGECKO_ATTRIBUTION : null,
			isDemoKey,
			demoHistoryDays: isDemoKey ? DEMO_HISTORY_DAYS : null,
			completeness: applied.missingUnits.length > 0 ? 'partial' : 'complete',
			unpricedUnits: [...applied.missingUnits],
		},
	};
}

export type ReportFiatCapability = Readonly<{
	isConfigured: boolean;
	isDemoKey: boolean;
	historyDays: number | null;
	earliestPriceableDate: Date | null;
	currencies: string[];
	modes: FiatRateMode[];
	attribution: string;
	setupHint: string;
}>;

const FIAT_SETUP_HINT =
	'Set COINGECKO_API_KEY in the service environment, and IS_COINGECKO_DEMO=true when the key is a free demo key. Restart the service after changing it.';

/** What the running service can price, so the UI can say so before a request. */
export function describeReportFiatCapability(): ReportFiatCapability {
	const isConfigured = isFiatRateProviderConfigured();
	const isDemoKey = isConfigured && isFiatRateProviderDemo();
	return {
		isConfigured,
		isDemoKey,
		historyDays: isDemoKey ? DEMO_HISTORY_DAYS : null,
		earliestPriceableDate: isConfigured ? getEarliestPriceableDate() : null,
		currencies: [...REPORT_FIAT_CURRENCIES],
		modes: [...REPORT_FIAT_MODES],
		attribution: COINGECKO_ATTRIBUTION,
		setupHint: FIAT_SETUP_HINT,
	};
}
