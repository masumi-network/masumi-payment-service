import { getReportAssetMetadata } from '@/utils/asset-units';
import type { ReportCsvMetadata } from './csv';
import type { ReportWarning } from './records';
import { fieldReferenceSection } from './export-readme-fields';

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
				? `the price closest in time to each request's own accounting instant, the one the date basis above picks. CoinGecko sets the spacing of its price series, so the nearest price is within minutes for a short report and within an hour for a longer one`
				: `the daily average rate of each request's own accounting date, so requests booked on different days used different rates`;
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

/**
 * What a note means for someone reading the numbers.
 *
 * The stored message states the technical cause. It does not say what to do
 * about it, and a reader closing the accounts needs that more than the cause.
 * Codes marked `expected` describe how the report is designed to work, so they
 * are listed apart from the ones that make a figure less exact.
 */
const WARNING_GUIDANCE: Record<string, Readonly<{ expected?: boolean; text: string }>> = {
	PROTOCOL_FEE_RECONSTRUCTED: {
		expected: true,
		text: 'Expected on a V1 contract. The fee rate is fixed when the payment source is created and cannot be changed afterwards, so the rate used is the rate charged. The rebuilt amount differs from the charged amount only where the escrow was topped up after the funds were locked.',
	},
	CARDANO_FEE_RECONCILIATION_PARTIAL: {
		text: 'The admin share of a network fee is what is left after the buyer and seller counters, and at least one of those counters is not final. Admin fee figures are missing that request rather than wrong for the ones they cover.',
	},
	ACTOR_CARDANO_FEE_EVENT_ALLOCATION_PARTIAL: {
		text: 'The stored buyer and seller fee counters run for the whole life of a request. A request that is still open, or whose first or last transaction sits outside these dates, is left out of the fee figures. An open request is the usual cause, and it resolves itself once the escrow ends.',
	},
	ECONOMIC_METRIC_EVIDENCE_PARTIAL: {
		text: 'At least one revenue, spend, or refund amount could not be established. Those cells are empty rather than zero, so that request is missing from the figures it would have joined.',
	},
	PROTOCOL_FEE_INSUFFICIENT_DATA: {
		text: 'At least one protocol fee could not be worked out at all. That request is missing from the fee figures, and its own cell is empty.',
	},
	DISPUTED_PAYOUT_PARTIAL: {
		text: 'A disputed request could not be split cleanly between the two sides. Treat the buyer and seller shares of that request as an apportionment.',
	},
	HISTORY_ACTOR_CARDANO_FEE_ALLOCATION_PARTIAL: {
		text: 'Only the day-by-day fee history is affected. A request pays a fee on the day it locks and again on the day it settles, and the stored counter records no split, so the whole amount sits on one day. Period totals are unaffected.',
	},
	HISTORY_CARDANO_FEE_ALLOCATION_PARTIAL: {
		text: 'Only the day-by-day fee history is affected. A fee shared by requests that settled on different days cannot be placed on one day. Period totals are unaffected.',
	},
	HISTORY_ECONOMIC_TIMESTAMP_MISSING: {
		text: 'Only the day-by-day history is affected. An amount with no confirmed chain time is left out of the daily figures, so the days can add up to less than the period total.',
	},
	CARDANO_FEE_COVERAGE_PARTIAL: {
		text: 'At least one request is missing from the network fee figures. The requests that are counted carry their exact fees.',
	},
	TRANSACTION_COUNT_PARTIAL: {
		text: 'A payment with no provable date for this period is not counted in it, so the count is missing that payment.',
	},
	PAGINATED_SNAPSHOT: {
		text: 'This export was read in pages. Rows come from one snapshot, so the pages still agree with each other.',
	},
};

function warningLines(warnings: readonly ReportWarning[]): string[] {
	return warnings.map((warning) => {
		const guidance = WARNING_GUIDANCE[warning.code]?.text;
		return `- **${warning.code}** ${warning.message}${guidance == null ? '' : ` ${guidance}`}`;
	});
}

function warningSection(metadata: ReportCsvMetadata): string[] {
	const warnings = metadata.warnings ?? [];
	const expected = warnings.filter((warning) => WARNING_GUIDANCE[warning.code]?.expected === true);
	const estimates = warnings.filter((warning) => WARNING_GUIDANCE[warning.code]?.expected !== true);
	const lines: string[] = [];
	if (estimates.length === 0) {
		lines.push('## Estimates', '', 'No figure in this export is an estimate.', '');
	} else {
		lines.push(
			'## Estimates',
			'',
			'A note appears below only where it applies to this report. The first sentence states the technical cause.',
			'The remainder states the effect on the figures.',
			'',
			...warningLines(estimates),
			'',
		);
	}
	if (expected.length > 0) {
		lines.push(
			'## Notes requiring no action',
			'',
			'These describe how the report is constructed rather than a shortfall in it.',
			'',
			...warningLines(expected),
			'',
		);
	}
	return lines;
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
		'- `transactions.csv`: one row per request and side, and the line-item detail behind the other two files.',
		'- `wallet-summary.csv`: the same amounts aggregated per managed wallet and side.',
		'- `totals.csv`: a single row covering the whole period.',
		'',
		'## Reading the money columns',
		'',
		'A request can be priced in ADA or in a stablecoin, so every amount is split across one column per asset:',
		'',
		'- `*_ada`: amounts in ADA',
		'- `*_usdm`: amounts in USDM',
		'- `*_usdcx`: amounts in USDCx',
		'- `*_other_assets_json`: any other token, as a JSON object mapping unit to atomic amount',
		...(fiatSuffix == null ? [] : [`- \`*_${fiatSuffix}\`: the converted amount, as described under Currency`]),
		'',
		'An empty amount cell means the figure could not be determined. It does not mean zero.',
		'',
		'Every aggregated figure also carries a `*_completeness` column. It reports coverage, not precision:',
		'',
		'- `complete`: every request that belongs in the figure is included.',
		'- `partial` beside a number: the number is exact for the requests it covers, and at least one further request',
		'  could not be established and is therefore absent from it.',
		'- `partial` beside an empty cell: no request could be established.',
		'',
		...fieldReferenceSection(metadata),
		...fiatSection(metadata),
		...warningSection(metadata),
		'## A note on Cardano network fees',
		'',
		'One Cardano transaction can settle several requests at once, and the chain records no breakdown of its',
		'fee. Such a fee is divided into equal parts, one per request the transaction settled. A transaction fee',
		'follows the size of the transaction rather than the amounts being paid, so each request in a batch costs',
		'about the same to settle.',
		'',
		'The parts add back up to the fee exactly, down to the lovelace, and the same transaction always divides',
		'the same way. A part is therefore the fee of that request, and it is reported the same way a fee paid by a',
		'single request is. What this means when you read the numbers:',
		'',
		'- A request that settled in a transaction of its own carries the whole fee.',
		'- A request that settled in a batch of three carries a third of it. The odd lovelace goes to the earliest',
		'  request in the batch, so the three parts still add up to the fee the chain charged.',
		'- When a filter or the date range leaves part of a batch out, this report counts only the parts belonging',
		'  to the requests it holds. The rest of the fee belongs to requests outside the report.',
		'',
		'A fee can still be unknown rather than divided. That happens when the service cannot list every request a',
		'transaction settled, because there is then no number to divide by.',
		'',
		'## Money not yet final',
		'',
		'`seller_pending_revenue` holds funds a buyer has locked for a request the seller has not been paid for. The',
		'outcome is undecided, so the amount is not revenue and is excluded from every revenue and fee figure. It is',
		'the full requested amount, before the protocol fee and network fees.',
		'',
		'Pending amounts are dated to the lock transaction, since no settlement event has occurred against which to',
		'date them. When the request settles, the amount leaves this figure and joins gross revenue, or returned',
		'funds if the buyer was repaid, dated to the settlement instead. A request that settles slowly therefore',
		'moves between reporting periods.',
		'',
	];
	return Buffer.from(lines.join('\n'), 'utf8');
}
