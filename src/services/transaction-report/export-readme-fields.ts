import type { ReportCsvMetadata } from './csv';

/**
 * The export's data dictionary.
 *
 * Every column of every file, as a summary and the rule that produced the
 * value. It sits beside the README generator rather than inside it because the
 * dictionary tracks the CSV schema while the README's framing does not.
 *
 * Rendered as tables. An earlier draft used `name - summary - detail` bullets,
 * which put an em dash and a bold run on every line of a 200-line document.
 */

type Field = Readonly<{ name: string; summary: string; detail: string }>;
type FieldGroup = Readonly<{ title: string; fields: readonly Field[] }>;

/** `*` stands for the per-asset suffixes documented under the money columns. */
const MONEY = '*';

const IDENTITY_FIELDS: readonly Field[] = [
	{
		name: 'id',
		summary: 'Record id',
		detail: 'The primary key of the payment or purchase record. Unique per row, and stable across reports.',
	},
	{
		name: 'blockchain_identifier',
		summary: 'Payment id shared by both sides',
		detail:
			'The seller record and the buyer record of one payment carry the same value. A report covering both sides therefore emits two rows per payment, which is why the distinct payment count is lower than the row count.',
	},
	{
		name: 'role',
		summary: 'Side of the trade',
		detail: '`Seller` or `Buyer`. A seller row populates the revenue columns and leaves the spend columns empty.',
	},
	{
		name: 'request_type',
		summary: 'Record type',
		detail: '`PaymentRequest` for a sale by this service. `PurchaseRequest` for a purchase.',
	},
	{
		name: 'on_chain_state',
		summary: 'Latest confirmed escrow state',
		detail:
			'A state of the payment contract, such as `FundsLocked`, `ResultSubmitted`, `Disputed`, `Withdrawn` or `RefundWithdrawn`. Empty when no state transition has been confirmed on chain.',
	},
	{
		name: 'agent_identifier',
		summary: 'Registered agent id',
		detail: 'Identifies the AI agent the request was raised against. Supplied by the party that registered the agent.',
	},
	{
		name: 'agent_name',
		summary: 'Registered agent name',
		detail: 'Display name from the same registration. Names are not unique, so join on the identifier instead.',
	},
	{
		name: 'metadata',
		summary: 'Caller-supplied text',
		detail: 'Stored verbatim with the request. This service never writes it, so treat it as untrusted input.',
	},
];

const DATE_FIELDS: readonly Field[] = [
	{
		name: 'created_at',
		summary: 'Record creation time',
		detail:
			'A database timestamp, not a block time. Present on every row, including requests that never reached the chain.',
	},
	{
		name: 'funds_locked_at',
		summary: 'Block time of the lock',
		detail:
			'Taken from the confirmed transaction that placed the buyer funds in the contract. No amount is attributed to the request before this time.',
	},
	{
		name: 'seller_revenue_recognized_at',
		summary: 'Block time revenue was earned',
		detail:
			'The event behind it depends on the revenue mode stated under "What this export covers". Empty while the request is unresolved.',
	},
	{
		name: 'buyer_gross_spend_at',
		summary: 'Block time the buyer funds left',
		detail: 'The confirmed event behind the gross spend amount. Empty when no such event is confirmed.',
	},
	{
		name: 'buyer_returned_at',
		summary: 'Block time funds returned',
		detail: 'The confirmed event behind returned funds. Empty when no return occurred.',
	},
];

const SETTLEMENT_FIELDS: readonly Field[] = [
	{
		name: 'result_submitted_tx_hash',
		summary: 'Result submission transaction',
		detail: 'Confirmed transactions only. Empty when the seller submitted no result.',
	},
	{
		name: 'settlement_tx_hash',
		summary: 'Withdraw transaction',
		detail:
			'The confirmed transaction that closed the escrow, and the transaction the settlement fee columns are derived from. Empty while the escrow is open.',
	},
	{
		name: 'settlement_tx_type',
		summary: 'How the escrow closed',
		detail:
			'`Withdrawn` for a seller payout, `RefundWithdrawn` for a buyer refund, `DisputedWithdrawn` for an administrator split.',
	},
];

const PARTY_FIELDS: readonly Field[] = [
	{
		name: 'managed_wallet_id',
		summary: 'Wallet held by this service',
		detail: 'Empty when this side of the trade is an external party rather than a wallet of this payment source.',
	},
	{
		name: 'managed_wallet_address',
		summary: 'Wallet address',
		detail: 'The on-chain address the funds moved through. Use it to locate the activity in a block explorer.',
	},
	{
		name: 'managed_wallet_vkey',
		summary: 'Wallet payment key hash',
		detail: 'Stable across address encodings, so it is the more reliable key when reconciling against other systems.',
	},
	{
		name: 'managed_wallet_collection_address',
		summary: 'Sweep destination',
		detail: 'Configured per selling wallet. Empty when no collection address is set.',
	},
	{
		name: 'managed_wallet_deleted_at',
		summary: 'Wallet archive time',
		detail:
			'Archived wallets still appear, because their activity remains part of the period. Empty for active wallets.',
	},
	{
		name: 'counterparty_address',
		summary: 'External party address',
		detail: 'Read from the chain, so it is untrusted text. Empty when the counterparty could not be resolved.',
	},
	{
		name: 'buyer_return_address',
		summary: 'Configured refund destination',
		detail: 'Recorded with the request. It states where a refund would be paid, not that one occurred.',
	},
	{
		name: 'seller_return_address',
		summary: 'Configured payout destination',
		detail: 'Recorded with the request on the same basis.',
	},
];

function amountFields(): readonly Field[] {
	return [
		{
			name: `seller_gross_revenue_${MONEY}`,
			summary: 'Amount invoiced',
			detail: 'The requested amount before any deduction. It is the starting figure of the revenue calculation.',
		},
		{
			name: `protocol_fee_${MONEY}`,
			summary: 'Fee retained by the payment source',
			detail:
				'A percentage of gross revenue, at the rate stated under "Payment source". Zero throughout on a V2 contract.',
		},
		{
			name: `seller_cardano_fees_${MONEY}`,
			summary: 'Network fee paid by the selling wallet',
			detail: 'Denominated in ADA. Cardano charges fees in ADA regardless of the asset a request was priced in.',
		},
		{
			name: `seller_net_revenue_${MONEY}`,
			summary: 'Amount retained by the seller',
			detail: 'Gross revenue less the protocol fee, the seller network fees, and any refund. Lower than gross revenue.',
		},
		{
			name: `buyer_gross_spend_${MONEY}`,
			summary: 'Amount paid by the buyer',
			detail: 'Measured before refunds are deducted and before buyer network fees are added.',
		},
		{
			name: `buyer_returned_funds_${MONEY}`,
			summary: 'Amount returned to the buyer',
			detail:
				'Covers refunds and the buyer portion of an administrator split. Zero on a request that completed normally.',
		},
		{
			name: `buyer_cardano_fees_${MONEY}`,
			summary: 'Network fee paid by the buying wallet',
			detail:
				'Denominated in ADA. A buyer incurs a fee to lock the funds, so this is non-zero even on a request that was later refunded.',
		},
		{
			name: `buyer_net_spend_${MONEY}`,
			summary: 'Total cost of the purchase',
			detail:
				'Gross spend plus buyer network fees, less any refund. It exceeds gross spend whenever a network fee was incurred.',
		},
	];
}

function rateFields(metadata: ReportCsvMetadata): readonly Field[] {
	if (metadata.fiat == null) return [];
	const suffix = metadata.fiat.currency.toLowerCase();
	return [
		{
			name: `ada_${suffix}_rate`,
			summary: 'Conversion rate applied to this row',
			detail: `One column per asset: \`ada_${suffix}_rate\`, \`usdm_${suffix}_rate\` and \`usdcx_${suffix}_rate\`. An empty rate means no price was available for that asset, in which case its converted column is also empty rather than zero.`,
		},
	];
}

const PROTOCOL_FEE_FIELDS: readonly Field[] = [
	{
		name: 'protocol_fee_configured_rate_permille',
		summary: 'Rate configured on the payment source',
		detail: 'Expressed in parts per thousand, so 50 denotes 5 percent. The rate is fixed at creation and immutable.',
	},
	{
		name: 'protocol_fee_configured_rate_percent',
		summary: 'The same rate as a percentage',
		detail: 'Provided so downstream tooling need not convert.',
	},
	{
		name: 'protocol_fee_applied_rate_permille',
		summary: 'Rate used for this row',
		detail: 'Matches the configured rate except where no fee could be derived, in which case it is empty.',
	},
	{
		name: 'protocol_fee_applied_rate_percent',
		summary: 'The applied rate as a percentage',
		detail: 'Same conversion.',
	},
	{
		name: 'protocol_fee_provenance',
		summary: 'Derivation method',
		detail:
			'`calculated` from a completed withdraw. `projected` from the stored request while the escrow is open. `exact_zero` where the contract charges no fee. `not_applicable` on a buyer row. `insufficient_data` where the inputs are absent.',
	},
	{
		name: 'protocol_fee_basis',
		summary: 'Amount the rate was applied to',
		detail:
			'`stored_requested_plus_collateral` is the requested funds plus the collateral held alongside them. `contract_version` marks a zero derived from the contract rather than from a calculation.',
	},
	{
		name: 'protocol_fee_completeness',
		summary: 'Confidence in the figure',
		detail:
			'`exact` is derived from settled amounts. `reconstructed` is rebuilt from the stored request. `not_applicable` and `insufficient_data` both indicate there is no figure to read.',
	},
	{
		name: 'seller_payout_completeness',
		summary: 'Whether the seller portion is exact',
		detail:
			'`partial` indicates the stored payout cannot be attributed cleanly between the two sides, which occurs after a dispute. Empty on a buyer row.',
	},
	{
		name: 'buyer_payout_completeness',
		summary: 'Whether the buyer portion is exact',
		detail: 'The same rule applied to the buying side. Empty on a seller row.',
	},
];

const FEE_ATTRIBUTION_FIELDS: readonly Field[] = [
	{
		name: 'seller_cardano_fee_timing',
		summary: 'How the seller fee was dated',
		detail:
			'`stored_cumulative` indicates a lifetime counter for the request. `accounting_allocation` indicates the amount was assigned to a single accounting date, because the chain records no per-day breakdown.',
	},
	{ name: 'buyer_cardano_fee_timing', summary: 'How the buyer fee was dated', detail: 'The same two values.' },
	{
		name: 'actor_cardano_fee_allocation_strategy',
		summary: 'Dating rule in force',
		detail:
			'`lifetime_cohort` groups the full life of the request. `accounting_allocation` assigns it to the accounting date. The report date basis selects between them.',
	},
	{
		name: 'actor_cardano_fee_allocation_completeness',
		summary: 'Whether the period contains every fee the request incurs',
		detail:
			'`complete` requires a settled request whose first and last confirmed transactions both fall inside the report dates. An open escrow can still incur a settlement fee, so it remains `partial` until it closes.',
	},
	{
		name: 'actor_cardano_fee_allocation_attached_at',
		summary: 'Date the fee was assigned to',
		detail: 'Empty where no date could be established, in which case the fee is omitted from the daily history.',
	},
	{
		name: 'fee_allocation_scope',
		summary: 'Whether the settling transaction was exclusive to this request',
		detail:
			'`single_request` carries the whole transaction fee. `shared_or_unknown` indicates the transaction settled several requests, so the fee was divided between them.',
	},
	{
		name: 'fee_component_scope',
		summary: 'Whether every fee-bearing transaction names this request alone',
		detail: '`partial` marks a request whose fees are interleaved with other requests in at least one transaction.',
	},
	{
		name: 'reconciliation_buyer_cardano_fee_ada',
		summary: 'Buyer portion of the settling fees',
		detail: 'Always ADA. Empty where the attribution could not be derived.',
	},
	{
		name: 'reconciliation_seller_cardano_fee_ada',
		summary: 'Seller portion',
		detail: 'Always ADA, on the same basis.',
	},
	{
		name: 'reconciliation_admin_cardano_fee_ada',
		summary: 'Portion borne by the service wallets',
		detail:
			'The residual after the buyer and seller portions. It represents expenditure by this service that no counterparty reimburses.',
	},
	{
		name: 'reconciliation_total_cardano_fee_ada',
		summary: 'Sum of the three portions',
		detail: 'The fee charged by the transactions behind this request, before attribution.',
	},
	{
		name: 'reconciliation_completeness',
		summary: 'Whether the attribution is exact',
		detail: '`partial` indicates at least one input was filtered out or unavailable.',
	},
	{
		name: 'reconciliation_is_aggregation_owner',
		summary: 'Deduplication marker',
		detail:
			'`true` on the single request that owns a fee incurred by several requests, so aggregates count that fee once. It carries no economic meaning and does not identify the paying wallet.',
	},
];

const AGGREGATE_FIELDS: readonly Field[] = [
	{
		name: 'transaction_count',
		summary: 'Distinct payments',
		detail:
			'A payment covered from both sides counts once. Each payment is attributed to the earliest bucket in the period for which it has a qualifying date.',
	},
	{
		name: 'transaction_count_completeness',
		summary: 'Whether every payment could be dated',
		detail: '`partial` indicates at least one payment lacks the confirmed time needed to establish period membership.',
	},
	{
		name: `seller_gross_revenue_${MONEY}`,
		summary: 'Revenue invoiced',
		detail: 'Sum of seller gross revenue in scope.',
	},
	{
		name: `seller_pending_revenue_${MONEY}`,
		summary: 'Escrow funds not yet resolved',
		detail: 'Described under "Money not yet final". Deliberately excluded from every revenue and fee figure.',
	},
	{
		name: `protocol_fees_${MONEY}`,
		summary: 'Fees retained by the payment source',
		detail: 'Zero throughout on a V2 contract.',
	},
	{
		name: `seller_cardano_fees_${MONEY}`,
		summary: 'Network fees paid by selling wallets',
		detail: 'Denominated in ADA.',
	},
	{
		name: `seller_net_revenue_${MONEY}`,
		summary: 'Amount retained by sellers',
		detail: 'Gross revenue less protocol fees, network fees and refunds.',
	},
	{
		name: `buyer_gross_spend_${MONEY}`,
		summary: 'Amount paid by buyers',
		detail: 'Before refunds and before network fees.',
	},
	{
		name: `returned_funds_${MONEY}`,
		summary: 'Amount returned to buyers',
		detail: 'Refunds and the buyer portion of administrator splits.',
	},
	{
		name: `buyer_cardano_fees_${MONEY}`,
		summary: 'Network fees paid by buying wallets',
		detail: 'Denominated in ADA.',
	},
	{
		name: `buyer_net_spend_${MONEY}`,
		summary: 'Total cost of buying',
		detail: 'Gross spend plus buyer network fees, less refunds.',
	},
	{
		name: `actor_cardano_fees_${MONEY}`,
		summary: 'Buyer and seller network fees combined',
		detail: 'The portion of the network fee borne by counterparty wallets.',
	},
	{
		name: `admin_cardano_fees_${MONEY}`,
		summary: 'Network fees borne by this service',
		detail: 'The residual portion, paid from the service wallets and not reimbursed.',
	},
	{
		name: `total_cardano_fees_${MONEY}`,
		summary: 'All network fees in the period',
		detail: 'Actor fees plus admin fees. Use this figure for a network cost line.',
	},
];

const WALLET_SUMMARY_FIELDS: readonly Field[] = [
	{
		name: 'history_fee_completeness',
		summary: 'Whether the daily fee history is exact',
		detail:
			'Identical on every row, because it describes the report rather than the wallet. It does not qualify the period totals, which carry their own completeness columns.',
	},
	{
		name: 'managed_wallet_id',
		summary: 'Wallet this row aggregates',
		detail: 'Empty on the row holding activity with no managed wallet behind it.',
	},
	{ name: 'managed_wallet_address', summary: 'Wallet address', detail: 'As defined for transactions.csv.' },
	{ name: 'managed_wallet_vkey', summary: 'Wallet payment key hash', detail: 'As defined for transactions.csv.' },
	{
		name: 'managed_wallet_collection_address',
		summary: 'Sweep destination',
		detail: 'As defined for transactions.csv.',
	},
	{ name: 'managed_wallet_deleted_at', summary: 'Wallet archive time', detail: 'As defined for transactions.csv.' },
	{
		name: 'role',
		summary: 'Side aggregated by this row',
		detail: 'A wallet used for both buying and selling produces two rows, so the two sides are never combined.',
	},
];

function renderGroup(group: FieldGroup): string[] {
	return [
		'',
		`#### ${group.title}`,
		'',
		'| Column | Summary | Detail |',
		'| --- | --- | --- |',
		...group.fields.map((field) => `| \`${field.name}\` | ${field.summary} | ${field.detail} |`),
	];
}

export function fieldReferenceSection(metadata: ReportCsvMetadata): string[] {
	const suffixNote =
		metadata.fiat == null
			? 'A `*` in a column name stands for the per-asset suffixes listed under "Reading the money columns".'
			: `A \`*\` in a column name stands for the per-asset suffixes listed under "Reading the money columns", including \`_${metadata.fiat.currency.toLowerCase()}\`.`;
	return [
		'## Field reference',
		'',
		suffixNote,
		'',
		'### transactions.csv',
		'',
		'One row per request and per side. The other two files aggregate these rows, so any figure elsewhere in the',
		'export can be traced back to them. A payment this service both sold and bought produces two rows.',
		...[
			{ title: 'Identification', fields: IDENTITY_FIELDS },
			{ title: 'Timestamps', fields: DATE_FIELDS },
			{ title: 'Settlement', fields: SETTLEMENT_FIELDS },
			{ title: 'Wallets and counterparties', fields: PARTY_FIELDS },
			{ title: 'Amounts', fields: [...amountFields(), ...rateFields(metadata)] },
			{ title: 'Protocol fee derivation', fields: PROTOCOL_FEE_FIELDS },
			{ title: 'Network fee attribution', fields: FEE_ATTRIBUTION_FIELDS },
		].flatMap(renderGroup),
		'',
		'### wallet-summary.csv',
		'',
		'The transactions.csv amounts aggregated per managed wallet and side, one row per combination. It answers',
		'which wallet earned or spent what, without reference to individual requests.',
		...[
			{ title: 'Wallet identification', fields: WALLET_SUMMARY_FIELDS },
			{ title: 'Aggregated amounts', fields: AGGREGATE_FIELDS },
		].flatMap(renderGroup),
		'',
		'Each aggregated amount also carries a `_completeness` column, defined under "Reading the money columns".',
		'',
		'### totals.csv',
		'',
		'A single row covering the whole period. It carries `history_fee_completeness` and the same aggregated',
		'amounts as wallet-summary.csv, without the wallet columns. Summing the wallet rows reproduces these totals,',
		'except for amounts that belong to no managed wallet.',
		'',
	];
}
