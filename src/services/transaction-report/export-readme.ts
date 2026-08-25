import { getReportAssetMetadata } from '@/utils/asset-units';
import type { ReportCsvMetadata } from './csv';

/**
 * The export's own documentation.
 *
 * The filters, snapshot time, and payment source used to occupy 25 columns on
 * every row of every file. They belong in prose, where each one can say what it
 * means, rather than in a wall of repeated cells nobody reads.
 */

const DATE_BASIS_TEXT: Record<ReportCsvMetadata['filters']['dateBasis'], string> = {
	CreatedAt: 'the day the request was created',
	FundsLockedAt: 'the day the funds were locked in the contract',
	RevenueRecognizedAt: 'the day the money was earned or spent',
};

const REVENUE_MODE_TEXT: Record<ReportCsvMetadata['filters']['revenueMode'], string> = {
	Billable: 'earned, counted once the escrow unlocks even if the payout is still in the contract (accrual)',
	CashReceived: 'paid out, counted only once the funds reach the wallet (cash)',
	RequestedGross: 'requested, counted at the amount asked for whether or not it settled',
};

function formatDate(value: Date | null): string {
	return value == null ? 'not set' : value.toISOString();
}

function formatList(values: readonly string[] | null, allText: string): string {
	if (values == null || values.length === 0) return allText;
	return values.join(', ');
}

function assetLabel(unit: string): string {
	return getReportAssetMetadata(unit)?.symbol ?? unit;
}

function fiatSection(metadata: ReportCsvMetadata): string[] {
	const fiat = metadata.fiat;
	if (fiat == null) {
		return [
			'## Currency',
			'',
			'No conversion was applied. Every money column is in its own asset, so do not add ADA and a stablecoin together.',
			'',
		];
	}
	const code = fiat.currency.toUpperCase();
	const modeText =
		fiat.mode === 'PeriodAverage'
			? `one average rate for the whole period, so every request in this export used the same rate`
			: fiat.mode === 'TransactionTime'
				? `the rate closest in time to each request's own settling transaction. CoinGecko sets the spacing of its price series, so the nearest price is within minutes for a short report and within an hour for a longer one`
				: `the rate of each request's own accounting date, so requests booked on different days used different rates`;
	const lines = [
		'## Currency',
		'',
		`Every money column also appears in ${code}, in a column ending \`_${fiat.currency.toLowerCase()}\`.`,
		'',
		`- Rate basis: ${modeText}.`,
		`- Rate source: ${fiat.provider === 'coingecko' ? 'CoinGecko' : 'rates supplied with the request'}.`,
		`- Completeness: ${fiat.completeness}.`,
	];
	if (fiat.unpricedUnits.length > 0) {
		lines.push(
			`- No rate was found for ${fiat.unpricedUnits.map(assetLabel).join(', ')}. Figures holding those assets carry no converted value, rather than counting as zero.`,
		);
	}
	if (fiat.rates != null && fiat.rates.length > 0) {
		lines.push('', 'Rates used:', '');
		for (const rate of fiat.rates) {
			lines.push(`- 1 ${assetLabel(rate.unit)} = ${rate.rate} ${code}`);
		}
	} else if (fiat.mode !== 'PeriodAverage') {
		lines.push(
			'',
			`Each request carries the rates it used, in the \`*_${fiat.currency.toLowerCase()}_rate\` columns of transactions.csv.`,
		);
	}
	if (fiat.attribution != null) lines.push('', fiat.attribution + '.');
	if (fiat.isDemoKey) {
		lines.push(
			`This service uses a free CoinGecko key, which prices only the last ${fiat.demoHistoryDays ?? 365} days.`,
		);
	}
	lines.push('');
	return lines;
}

function warningSection(metadata: ReportCsvMetadata): string[] {
	const warnings = metadata.warnings ?? [];
	if (warnings.length === 0) {
		return ['## Estimates', '', 'No figure in this export is an estimate.', ''];
	}
	return [
		'## Estimates',
		'',
		'Some figures could not be derived exactly. Each note below says why.',
		'',
		...warnings.map((warning) => `- **${warning.code}** ${warning.message}`),
		'',
	];
}

export function createReportReadme(metadata: ReportCsvMetadata): Buffer {
	const filters = metadata.filters;
	const fiatSuffix = metadata.fiat == null ? null : metadata.fiat.currency.toLowerCase();
	const lines = [
		'# Masumi transaction report',
		'',
		`Generated ${formatDate(metadata.generatedAt)}.`,
		'',
		'Every figure in this export comes from one database snapshot, so the files agree with each other.',
		'',
		'## What this export covers',
		'',
		`- Snapshot taken at: ${formatDate(metadata.asOf)}`,
		`- Period: ${formatDate(filters.from)} up to but not including ${formatDate(filters.to)}`,
		`- Time zone used for day and period boundaries: ${filters.timeZone}`,
		`- A request counts on: ${DATE_BASIS_TEXT[filters.dateBasis]}`,
		`- Money counts when it is: ${REVENUE_MODE_TEXT[filters.revenueMode]}`,
		`- History grouped by: ${metadata.bucket}${metadata.requestedBucket === 'Auto' ? ' (chosen automatically)' : ''}`,
		'',
		'## Payment source',
		'',
		`- Id: ${metadata.paymentSource.id}`,
		`- Network: ${metadata.paymentSource.network}`,
		`- Contract version: ${metadata.paymentSource.paymentSourceType}`,
		`- Contract address: ${metadata.paymentSource.smartContractAddress}`,
		metadata.paymentSource.paymentSourceType === 'Web3CardanoV2'
			? '- Protocol fee: none. The V2 contract takes no protocol fee.'
			: `- Protocol fee rate: ${metadata.paymentSource.feeRatePermille / 10}% of gross revenue`,
		...(metadata.paymentSource.deletedAt == null
			? []
			: [`- Archived on: ${formatDate(metadata.paymentSource.deletedAt)}`]),
		'',
		'## Filters applied',
		'',
		`- Sides: ${formatList(filters.roles, 'both selling and buying')}`,
		`- Managed wallets: ${formatList(filters.managedWalletIds, 'all wallets of this payment source')}`,
		`- Counterparty addresses: ${formatList(filters.externalAddresses, 'no address filter')}`,
		`- Request states: ${formatList(filters.states, 'all states')}`,
		'',
		'## Files',
		'',
		'- `transactions.csv` — one row per request and side. The line-item detail behind everything else.',
		'- `wallet-summary.csv` — the same money, added up per managed wallet and side.',
		'- `totals.csv` — one row for the whole period.',
		'',
		'## Reading the money columns',
		'',
		'Each figure gets one column per asset, because a request can be paid in ADA or in a stablecoin:',
		'',
		'- `*_ada` — amounts in ADA',
		'- `*_usdm` — amounts in USDM',
		'- `*_usdcx` — amounts in USDCx',
		'- `*_other_assets_json` — any other token, as a JSON object of unit to atomic amount',
		...(fiatSuffix == null ? [] : [`- \`*_${fiatSuffix}\` — the same money converted, see Currency below`]),
		'',
		'An empty money cell means the figure could not be determined, which is not the same as zero.',
		'',
		...fiatSection(metadata),
		...warningSection(metadata),
		'## A note on Cardano network fees',
		'',
		'One Cardano transaction can settle several requests at once, and the chain records no breakdown of its',
		'fee. Such a fee is divided into equal parts, one per request the transaction settled. A transaction fee',
		'follows the size of the transaction rather than the amounts being paid, so each request in a batch costs',
		'about the same to settle.',
		'',
		'What this means when you read the numbers:',
		'',
		'- A request that settled in a transaction of its own carries the exact fee.',
		'- A request that settled in a batch of three carries a third of that fee, and the figure is an estimate.',
		'- Equal parts add back up to the fee exactly. The odd lovelace goes to the earliest request in the batch.',
		'- A period total is exact when every batch it touches is fully inside this report. When a filter or the',
		'  date range left part of a batch out, the report counts only its own share and marks the total partial.',
		'',
		'A fee can still be unknown rather than shared. That happens when the service cannot list every request a',
		'transaction settled, because there is then no number to divide by.',
		'',
		'## Money not yet earned',
		'',
		'`seller_pending_revenue` holds the funds a buyer has locked for a request the seller has not been paid',
		'for yet. It is not revenue, so it is left out of every revenue and fee figure. It is counted on the day',
		'the funds were locked, which is the only date this money has.',
		'',
		'A request leaves this figure once it settles, whichever way it settles. Its amount then appears in gross',
		'revenue, or in returned funds if the buyer got the money back.',
		'',
	];
	return Buffer.from(lines.join('\n'), 'utf8');
}
