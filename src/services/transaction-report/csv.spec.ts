import { describe, expect, it, jest } from '@jest/globals';
import { MAINNET_USDCX_UNIT, MAINNET_USDM_UNIT, PREPROD_USDM_UNIT } from '@/utils/asset-units';
import { aggregateReportRows } from './aggregate';
import {
	createTotalsCsv,
	createTransactionsCsv,
	createWalletSummaryCsv,
	ReportCsvSizeLimitError,
	type ReportCsvMetadata,
} from './csv';
import { buildReportRow, type ReportRequestRecord, type ReportRow } from './records';

const FROM = new Date('2026-01-01T00:00:00.000Z');
const TO = new Date('2026-02-01T00:00:00.000Z');
const AS_OF = new Date('2026-02-02T00:00:00.000Z');

function record(overrides: Partial<ReportRequestRecord> = {}): ReportRequestRecord {
	return {
		id: 'request-1',
		role: 'Seller',
		requestType: 'PaymentRequest',
		createdAt: new Date('2026-01-02T03:04:05.000Z'),
		blockchainIdentifier: 'chain-1',
		agentIdentifier: 'agent-1',
		agentName: 'Agent One',
		onChainState: 'Withdrawn',
		metadata: '{"source":"test"}',
		managedWallet: {
			id: 'wallet-1',
			walletAddress: 'addr-wallet',
			walletVkey: 'wallet-vkey',
			collectionAddress: 'addr-collection',
			deletedAt: null,
		},
		counterpartyAddress: 'addr-counterparty',
		buyerReturnAddress: null,
		sellerReturnAddress: 'addr-seller-return',
		paymentSourceType: 'Web3CardanoV1',
		configuredFeeRatePermille: 50,
		unlockTime: BigInt(new Date('2026-01-02T00:00:00.000Z').getTime()),
		collateralReturnLovelace: 2_000_000n,
		requestedFunds: [
			{ unit: 'lovelace', amount: 1_234_567n },
			{ unit: MAINNET_USDM_UNIT, amount: 2_500_000n },
			{ unit: PREPROD_USDM_UNIT, amount: 500_000n },
			{ unit: MAINNET_USDCX_UNIT, amount: 3_000_001n },
			{ unit: 'zz-policy-token', amount: 4n },
			{ unit: 'aa-policy-token', amount: 9_007_199_254_740_993n },
		],
		withdrawnForBuyer: [],
		withdrawnForSeller: [],
		buyerPayoutCompleteness: 'complete',
		sellerPayoutCompleteness: 'complete',
		buyerCardanoFees: 0n,
		sellerCardanoFees: 123_456n,
		transactions: [
			{
				id: 'transaction-1',
				txHash: 'hash-1',
				status: 'Confirmed',
				newOnChainState: 'Withdrawn',
				blockTime: Math.floor(new Date('2026-01-03T00:00:00.000Z').getTime() / 1000),
				fees: 223_456n,
				relatedRequestKeys: ['Seller:request-1'],
				relatedPaymentKeys: ['chain-1'],
			},
		],
		feeAllocationScope: 'single_request',
		isFeeReconciliationOwner: true,
		feeComponentScope: 'complete',
		...overrides,
	};
}

function row(overrides: Partial<ReportRequestRecord> = {}): ReportRow {
	return buildReportRow(record(overrides), 'RequestedGross', AS_OF, {
		dateBasis: 'CreatedAt',
		from: FROM,
		to: TO,
	});
}

function metadata(overrides: Partial<ReportCsvMetadata> = {}): ReportCsvMetadata {
	return {
		generatedAt: new Date('2026-02-02T01:02:03.000Z'),
		asOf: AS_OF,
		paymentSource: {
			id: 'source-1',
			network: 'Preprod',
			paymentSourceType: 'Web3CardanoV1',
			feeRatePermille: 50,
			smartContractAddress: 'addr-contract',
			deletedAt: null,
		},
		filters: {
			paymentSourceId: 'source-1',
			managedWalletIds: ['wallet-z', 'wallet-a'],
			externalAddresses: ['addr-z', 'addr-a'],
			roles: ['Seller', 'Buyer'],
			states: ['Withdrawn'],
			from: FROM,
			to: TO,
			dateBasis: 'CreatedAt',
			revenueMode: 'RequestedGross',
			timeZone: 'Etc/UTC',
		},
		requestedBucket: 'Auto',
		bucket: 'Day',
		warnings: [
			{ code: 'Z_WARNING', message: 'z', rowId: null },
			{ code: 'A_WARNING', message: 'a', rowId: null },
		],
		...overrides,
	};
}

function parseCsv(buffer: Buffer): string[][] {
	const text = buffer.toString('utf8');
	const rows: string[][] = [];
	let rowValues: string[] = [];
	let value = '';
	let inQuotes = false;
	for (let index = 0; index < text.length; index += 1) {
		const character = text[index];
		if (inQuotes) {
			if (character === '"' && text[index + 1] === '"') {
				value += '"';
				index += 1;
			} else if (character === '"') inQuotes = false;
			else value += character;
		} else if (character === '"') inQuotes = true;
		else if (character === ',') {
			rowValues.push(value);
			value = '';
		} else if (character === '\r' && text[index + 1] === '\n') {
			rowValues.push(value);
			rows.push(rowValues);
			rowValues = [];
			value = '';
			index += 1;
		} else value += character;
	}
	return rows;
}

function csvRecord(buffer: Buffer, rowIndex = 1): Record<string, string> {
	const rows = parseCsv(buffer);
	return Object.fromEntries(rows[0].map((header, index) => [header, rows[rowIndex][index]]));
}

describe('transaction report CSV', () => {
	it('carries the withdraw transaction hash and names the withdraw type', () => {
		const output = createTransactionsCsv([row()], metadata());
		const values = csvRecord(output);

		expect(values.settlement_tx_hash).toBe('hash-1');
		expect(values.settlement_tx_type).toBe('Withdrawn');
		expect(values.result_submitted_tx_hash).toBe('');
	});

	it('carries the result submission hash while the escrow is still open', () => {
		const output = createTransactionsCsv(
			[
				row({
					onChainState: 'ResultSubmitted',
					transactions: [
						{
							id: 'transaction-submit',
							txHash: 'hash-submit',
							status: 'Confirmed',
							newOnChainState: 'ResultSubmitted',
							blockTime: Math.floor(new Date('2026-01-03T00:00:00.000Z').getTime() / 1000),
							fees: 0n,
							relatedRequestKeys: ['Seller:request-1'],
							relatedPaymentKeys: ['chain-1'],
						},
					],
				}),
			],
			metadata(),
		);
		const values = csvRecord(output);

		expect(values.result_submitted_tx_hash).toBe('hash-submit');
		expect(values.settlement_tx_hash).toBe('');
		expect(values.settlement_tx_type).toBe('');
	});

	it('exports normalized asset decimals and exact unknown atomic amounts', () => {
		const output = createTransactionsCsv([row()], metadata());
		const values = csvRecord(output);

		expect(values.seller_gross_revenue_ada).toBe('1.234567');
		expect(values.seller_gross_revenue_usdm).toBe('3.000000');
		expect(values.seller_gross_revenue_usdcx).toBe('3.000001');
		expect(values.seller_gross_revenue_other_assets_json).toBe(
			'{"aa-policy-token":"9007199254740993","zz-policy-token":"4"}',
		);
		expect(values.protocol_fee_configured_rate_permille).toBe('50');
		expect(values.protocol_fee_configured_rate_percent).toBe('5.0');
		expect(values.protocol_fee_completeness).toBe('reconstructed');
		expect(values.reconciliation_total_cardano_fee_ada).toBe('0.223456');
		expect(values.reconciliation_completeness).toBe('partial');
	});

	it('keeps buyer metrics separate from non-applicable seller metrics', () => {
		const buyer = row({
			id: 'purchase-1',
			role: 'Buyer',
			requestType: 'PurchaseRequest',
			buyerCardanoFees: 100_000n,
			sellerCardanoFees: 0n,
			transactions: [
				{
					...record().transactions[0],
					id: 'buyer-lock',
					txHash: 'buyer-lock-hash',
					newOnChainState: 'FundsLocked',
					fees: 0n,
					relatedRequestKeys: ['Buyer:purchase-1'],
				},
			],
		});
		const values = csvRecord(createTransactionsCsv([buyer], metadata()));

		expect(values.role).toBe('Buyer');
		expect(values.seller_gross_revenue_ada).toBe('');
		expect(values.protocol_fee_ada).toBe('');
		expect(values.buyer_gross_spend_ada).toBe('1.234567');
		expect(values.buyer_gross_spend_usdm).toBe('3.000000');
		expect(values.buyer_cardano_fees_ada).toBe('0.100000');
		expect(values.buyer_cardano_fee_timing).toBe('stored_cumulative');
		expect(values.buyer_payout_completeness).toBe('complete');
	});

	it('quotes every field, escapes quotes, and protects only untrusted formula-like text', () => {
		const dangerous = row({
			id: '\tcommand',
			blockchainIdentifier: '\rcommand',
			agentIdentifier: '+command',
			agentName: '  =SUM("x",1)',
			counterpartyAddress: '-command',
			buyerReturnAddress: '@command',
			metadata: '\ncommand',
		});
		const output = createTransactionsCsv([dangerous], metadata());
		const values = csvRecord(output);

		expect(values.id).toBe("'\tcommand");
		expect(values.blockchain_identifier).toBe("'\rcommand");
		expect(values.agent_identifier).toBe("'+command");
		expect(values.agent_name).toBe('\'  =SUM("x",1)');
		expect(values.counterparty_address).toBe("'-command");
		expect(values.buyer_return_address).toBe("'@command");
		expect(values.metadata).toBe("'\ncommand");
		expect(output.toString('utf8')).toContain('"\'  =SUM(""x"",1)"');
		expect(values.seller_net_revenue_ada.startsWith("'")).toBe(false);
	});

	it('uses CRLF records and returns identical bytes for identical input', () => {
		const reportRow = row();
		const reportMetadata = metadata();
		const first = createTransactionsCsv([reportRow], reportMetadata);
		const second = createTransactionsCsv([reportRow], reportMetadata);
		const withoutRecords = first.toString('utf8').replaceAll('\r\n', '');

		expect(first.equals(second)).toBe(true);
		expect(first.toString('utf8').endsWith('\r\n')).toBe(true);
		expect(withoutRecords).not.toMatch(/[\r\n]/u);
		expect(first.toString('utf8').startsWith('"id","blockchain_identifier","role"')).toBe(true);
	});

	it('carries no report context columns, because the export README holds them', () => {
		const output = createTransactionsCsv(
			[row(), row({ id: 'request-2', blockchainIdentifier: 'chain-2' })],
			metadata(),
		);
		const parsedRows = parseCsv(output);
		const headers = parsedRows[0];

		expect(parsedRows).toHaveLength(3);
		expect(new Set(headers).size).toBe(headers.length);
		for (const header of ['record_type', 'generated_at', 'as_of', 'payment_source_id', 'filter_states_json']) {
			expect(headers).not.toContain(header);
		}
		expect(csvRecord(output).id).toBe('request-1');
		expect(csvRecord(output, 2).id).toBe('request-2');
	});

	it('writes only a header row when the period holds no request', () => {
		const output = createTransactionsCsv([], metadata());
		const rows = parseCsv(output);

		expect(rows).toHaveLength(1);
		expect(rows[0]).toContain('seller_gross_revenue_ada');
	});

	it('measures multibyte, quote, and formula escaping before allocating the final buffer', () => {
		const reportRow = row({ agentName: '  =λ"😀,value' });
		const unrestricted = createTransactionsCsv([reportRow], metadata());
		const exactBytes = unrestricted.byteLength;

		expect(createTransactionsCsv([reportRow], metadata(), { maxBytes: exactBytes })).toEqual(unrestricted);
		expect(csvRecord(unrestricted).agent_name).toBe('\'  =λ"😀,value');

		const allocationSpy = jest.spyOn(Buffer, 'allocUnsafe');
		let thrown: unknown;
		try {
			createTransactionsCsv([reportRow], metadata(), { maxBytes: exactBytes - 1 });
		} catch (error) {
			thrown = error;
		}
		const allocationCalls = allocationSpy.mock.calls.length;
		allocationSpy.mockRestore();

		expect(allocationCalls).toBe(0);
		expect(thrown).toBeInstanceOf(ReportCsvSizeLimitError);
		expect(thrown).toMatchObject({ maxBytes: exactBytes - 1, statusCode: 413 });
	});
});

describe('transaction report aggregate CSV', () => {
	it('includes exact financial and completeness figures in totals', () => {
		const reportRow = row();
		const result = aggregateReportRows([reportRow], 'Day', 'Etc/UTC', FROM, TO, 'CreatedAt');
		const output = createTotalsCsv(result, metadata());
		const values = csvRecord(output);

		expect(values.transaction_count).toBe('1');
		expect(values.seller_gross_revenue_ada).toBe('1.234567');
		expect(values.seller_gross_revenue_completeness).toBe('complete');
		expect(values.actor_cardano_fees_ada).toBe('0.123456');
		expect(values.actor_cardano_fees_completeness).toBe('partial');
		// Unknown, not zero: the admin share cannot be derived from a partial
		// actor figure, and a zero here would contradict the total beside it.
		expect(values.admin_cardano_fees_ada).toBe('');
		expect(values.admin_cardano_fees_completeness).toBe('partial');
		expect(values.total_cardano_fees_ada).toBe('0.223456');
		expect(values.total_cardano_fees_completeness).toBe('complete');
	});

	it('sorts wallet rows and includes role-specific summary metrics', () => {
		const first = row({ managedWallet: { ...record().managedWallet!, id: 'wallet-z' } });
		const second = row({
			id: 'request-2',
			blockchainIdentifier: 'chain-2',
			managedWallet: { ...record().managedWallet!, id: 'wallet-a' },
		});
		const result = aggregateReportRows([first, second], 'Day', 'Etc/UTC', FROM, TO, 'CreatedAt');
		const output = createWalletSummaryCsv(result, metadata());
		const rows = parseCsv(output);
		const firstValues = csvRecord(output);
		const secondValues = csvRecord(output, 2);

		expect(rows).toHaveLength(3);
		expect(rows[0]).not.toContain('payment_source_id');
		expect(firstValues.managed_wallet_id).toBe('wallet-a');
		expect(firstValues.role).toBe('Seller');
		expect(firstValues.seller_gross_revenue_usdm).toBe('3.000000');
		expect(firstValues.protocol_fees_completeness).toBe('partial');
		expect(firstValues.actor_cardano_fees_ada).toBe('0.123456');
		expect(secondValues.managed_wallet_id).toBe('wallet-z');
	});

	it('writes only a header row when no wallet moved money', () => {
		const result = aggregateReportRows([], 'Day', 'Etc/UTC', FROM, TO, 'CreatedAt');
		const output = createWalletSummaryCsv(result, metadata());
		const rows = parseCsv(output);

		expect(rows).toHaveLength(1);
		expect(rows[0]).toContain('managed_wallet_id');
		expect(rows[0]).toContain('total_cardano_fees_completeness');
	});
});
