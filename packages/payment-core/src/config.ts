import dotenv from 'dotenv';
import {
	getOwnEntries,
	getOwnString,
	getOwnValue,
	isPlainObject,
	type RuntimePropertyValue,
} from './object-properties';

dotenv.config();
if (process.env.DATABASE_URL == null) throw new Error('Undefined DATABASE_URL ENV variable');
if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length < 20)
	throw new Error('Undefined or unsecure ENCRYPTION_KEY ENV variable. Require min 20 char');

// Parse a numeric env var and reject non-finite values (NaN/Infinity) as well
// as out-of-range values. A bare `Number('20s')` yields NaN, and `NaN < min`
// is always false, so a plain `< min` guard silently lets typo'd config boot
// and then feeds NaN into `setTimeout`/threshold math (delay coerces to 0 ->
// cron hot-loop; `confirmations >= NaN` never true). `Number.isFinite` closes
// that hole.
function parseNumberEnv(name: string, rawValue: string | undefined, fallback: string, minValue: number): number {
	const parsed = Number(rawValue ?? fallback);
	if (!Number.isFinite(parsed)) {
		throw new Error(`${name} must be a valid number`);
	}
	if (parsed < minValue) {
		throw new Error(`${name} must be at least ${minValue}`);
	}
	return parsed;
}

const batchPaymentInterval = parseNumberEnv('BATCH_PAYMENT_INTERVAL', process.env.BATCH_PAYMENT_INTERVAL, '30', 5);
const checkTxInterval = parseNumberEnv('CHECK_TX_INTERVAL', process.env.CHECK_TX_INTERVAL, '20', 15);
const checkCollectionInterval = parseNumberEnv(
	'CHECK_COLLECTION_INTERVAL',
	process.env.CHECK_COLLECTION_INTERVAL,
	'15',
	5,
);
const checkCollectRefundInterval = parseNumberEnv(
	'CHECK_COLLECT_REFUND_INTERVAL',
	process.env.CHECK_COLLECT_REFUND_INTERVAL,
	'15',
	5,
);
const checkSetRefundInterval = parseNumberEnv(
	'CHECK_SET_REFUND_INTERVAL',
	process.env.CHECK_SET_REFUND_INTERVAL,
	'15',
	5,
);
const checkUnsetRefundInterval = parseNumberEnv(
	'CHECK_UNSET_REFUND_INTERVAL',
	process.env.CHECK_UNSET_REFUND_INTERVAL,
	'15',
	5,
);
const checkWalletTransactionHashInterval = parseNumberEnv(
	'CHECK_WALLET_TRANSACTION_HASH_INTERVAL',
	process.env.CHECK_WALLET_TRANSACTION_HASH_INTERVAL,
	'20',
	5,
);
const checkAuthorizeRefundInterval = parseNumberEnv(
	'CHECK_AUTHORIZE_REFUND_INTERVAL',
	process.env.CHECK_AUTHORIZE_REFUND_INTERVAL,
	'15',
	5,
);
const checkAuthorizeWithdrawalInterval = parseNumberEnv(
	'CHECK_AUTHORIZE_WITHDRAWAL_INTERVAL',
	process.env.CHECK_AUTHORIZE_WITHDRAWAL_INTERVAL,
	'15',
	5,
);
const checkSubmitResultInterval = parseNumberEnv(
	'CHECK_SUBMIT_RESULT_INTERVAL',
	process.env.CHECK_SUBMIT_RESULT_INTERVAL,
	'15',
	5,
);
const registerAgentInterval = parseNumberEnv('REGISTER_AGENT_INTERVAL', process.env.REGISTER_AGENT_INTERVAL, '15', 5);
const deregisterAgentInterval = parseNumberEnv(
	'DEREGISTER_AGENT_INTERVAL',
	process.env.DEREGISTER_AGENT_INTERVAL,
	'15',
	5,
);

const autoWithdrawPayments =
	process.env.AUTO_WITHDRAW_PAYMENTS?.toLowerCase() === 'true' ||
	process.env.AUTO_WITHDRAW_PAYMENTS === '' ||
	process.env.AUTO_WITHDRAW_PAYMENTS == undefined;
const autoWithdrawRefunds =
	process.env.AUTO_WITHDRAW_REFUNDS?.toLowerCase() === 'true' ||
	process.env.AUTO_WITHDRAW_REFUNDS === '' ||
	process.env.AUTO_WITHDRAW_REFUNDS == undefined;

const checkRegistryTransactionsInterval = parseNumberEnv(
	'CHECK_REGISTRY_TRANSACTIONS_INTERVAL',
	process.env.CHECK_REGISTRY_TRANSACTIONS_INTERVAL,
	'15',
	5,
);

const autoDecisionInterval = parseNumberEnv('AUTO_DECISION_INTERVAL', process.env.AUTO_DECISION_INTERVAL, '30', 5);

const webhookDeliveryInterval = parseNumberEnv(
	'WEBHOOK_DELIVERY_INTERVAL',
	process.env.WEBHOOK_DELIVERY_INTERVAL,
	'10',
	5,
);

const webhookCleanupInterval = parseNumberEnv(
	'WEBHOOK_CLEANUP_INTERVAL',
	process.env.WEBHOOK_CLEANUP_INTERVAL,
	String(24 * 60 * 60),
	5,
);

const blockConfirmationsThreshold = parseNumberEnv(
	'BLOCK_CONFIRMATIONS_THRESHOLD',
	process.env.BLOCK_CONFIRMATIONS_THRESHOLD,
	'1',
	0,
);

const syncLockTimeoutInterval = parseNumberEnv(
	'SYNC_LOCK_TIMEOUT_INTERVAL',
	process.env.SYNC_LOCK_TIMEOUT_INTERVAL,
	'300',
	5,
);

const walletLockTimeoutInterval = parseNumberEnv(
	'WALLET_LOCK_TIMEOUT_INTERVAL',
	process.env.WALLET_LOCK_TIMEOUT_INTERVAL,
	'300',
	5,
);

export type LowBalanceDefaultRule = {
	assetUnit: string;
	thresholdAmount: string;
};

type LowBalanceRuleCandidate = {
	assetUnit: string;
	thresholdAmount: RuntimePropertyValue;
};

function normalizeThresholdAmount(value: RuntimePropertyValue, path: string): string {
	const thresholdString =
		typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint' ? String(value).trim() : '';
	if (!/^\d+$/.test(thresholdString)) {
		throw new Error(`${path}.thresholdAmount must be a non-negative integer string`);
	}

	return thresholdString;
}

function parseLowBalanceRuleCandidate(candidate: LowBalanceRuleCandidate, path: string): LowBalanceDefaultRule {
	if (candidate.assetUnit.trim() === '') {
		throw new Error(`${path}.assetUnit must be a non-empty string`);
	}

	return {
		assetUnit: candidate.assetUnit,
		thresholdAmount: normalizeThresholdAmount(candidate.thresholdAmount, path),
	};
}

function parseLowBalanceRuleObject(value: unknown, path: string): LowBalanceDefaultRule {
	if (!isPlainObject(value)) {
		throw new Error(`${path} must be an object`);
	}

	const assetUnit = getOwnString(value, 'assetUnit');
	if (assetUnit == null) {
		throw new Error(`${path}.assetUnit must be a non-empty string`);
	}

	return parseLowBalanceRuleCandidate(
		{
			assetUnit,
			thresholdAmount: getOwnValue(value, 'thresholdAmount'),
		},
		path,
	);
}

function parseLowBalanceDefaultRules(
	envVarName: 'LOW_BALANCE_DEFAULT_RULES_MAINNET' | 'LOW_BALANCE_DEFAULT_RULES_PREPROD',
): LowBalanceDefaultRule[] {
	const rawValue = process.env[envVarName];
	if (rawValue == null || rawValue.trim() === '') {
		return [];
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(rawValue);
	} catch (error) {
		throw new Error(`${envVarName} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}

	if (Array.isArray(parsed)) {
		return parsed.map((rule, index) => parseLowBalanceRuleObject(rule, `${envVarName}[${index}]`));
	}

	if (!isPlainObject(parsed)) {
		throw new Error(`${envVarName} must be a JSON object map or array of rules`);
	}

	return getOwnEntries(parsed).map(([assetUnit, thresholdAmount], index) =>
		parseLowBalanceRuleCandidate(
			{
				assetUnit,
				thresholdAmount,
			},
			`${envVarName}[${index}]`,
		),
	);
}

const lowBalanceCheckInterval = parseNumberEnv(
	'LOW_BALANCE_CHECK_INTERVAL',
	process.env.LOW_BALANCE_CHECK_INTERVAL,
	'60',
	5,
);

const simpleApiSyncInterval = Number(process.env.SIMPLE_API_SYNC_INTERVAL ?? '300');
if (simpleApiSyncInterval < 30) throw new Error('SIMPLE_API_SYNC_INTERVAL must be at least 30 seconds');

const registryServiceUrl = process.env.REGISTRY_SERVICE_URL ?? '';
const registryApiKey = process.env.REGISTRY_API_KEY ?? '';

const x402FacilitatorUrlEnv = process.env.X402_FACILITATOR_URL;
const x402FacilitatorUrlIsExplicit = x402FacilitatorUrlEnv != null && x402FacilitatorUrlEnv.trim() !== '';
const x402FacilitatorUrl =
	x402FacilitatorUrlEnv != null && x402FacilitatorUrlEnv.trim() !== ''
		? x402FacilitatorUrlEnv.trim()
		: 'https://x402.org/facilitator';

const lowBalanceDefaultRulesMainnet = parseLowBalanceDefaultRules('LOW_BALANCE_DEFAULT_RULES_MAINNET');
const lowBalanceDefaultRulesPreprod = parseLowBalanceDefaultRules('LOW_BALANCE_DEFAULT_RULES_PREPROD');

export const CONFIG = {
	PORT: process.env.PORT ?? '3001',
	DATABASE_URL: process.env.DATABASE_URL,
	SYNC_LOCK_TIMEOUT_INTERVAL: syncLockTimeoutInterval * 1000,
	WALLET_LOCK_TIMEOUT_INTERVAL: walletLockTimeoutInterval * 1000,
	LOW_BALANCE_CHECK_INTERVAL: lowBalanceCheckInterval,
	BATCH_PAYMENT_INTERVAL: batchPaymentInterval,
	BLOCK_CONFIRMATIONS_THRESHOLD: blockConfirmationsThreshold,
	CHECK_TX_INTERVAL: checkTxInterval,
	CHECK_COLLECTION_INTERVAL: checkCollectionInterval,
	CHECK_COLLECT_REFUND_INTERVAL: checkCollectRefundInterval,
	CHECK_SET_REFUND_INTERVAL: checkSetRefundInterval,
	CHECK_UNSET_REFUND_INTERVAL: checkUnsetRefundInterval,
	CHECK_WALLET_TRANSACTION_HASH_INTERVAL: checkWalletTransactionHashInterval,
	CHECK_AUTHORIZE_REFUND_INTERVAL: checkAuthorizeRefundInterval,
	CHECK_AUTHORIZE_WITHDRAWAL_INTERVAL: checkAuthorizeWithdrawalInterval,
	CHECK_SUBMIT_RESULT_INTERVAL: checkSubmitResultInterval,
	REGISTER_AGENT_INTERVAL: registerAgentInterval,
	DEREGISTER_AGENT_INTERVAL: deregisterAgentInterval,
	CHECK_REGISTRY_TRANSACTIONS_INTERVAL: checkRegistryTransactionsInterval,
	ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
	AUTO_WITHDRAW_PAYMENTS: autoWithdrawPayments,
	AUTO_WITHDRAW_REFUNDS: autoWithdrawRefunds,
	AUTO_DECISION_INTERVAL: autoDecisionInterval,
	WEBHOOK_DELIVERY_INTERVAL: webhookDeliveryInterval,
	WEBHOOK_CLEANUP_INTERVAL: webhookCleanupInterval,
	// OpenTelemetry configuration
	OTEL_SERVICE_NAME: process.env.OTEL_SERVICE_NAME ?? 'masumi-payment-service',
	OTEL_SERVICE_VERSION: process.env.OTEL_SERVICE_VERSION ?? '0.1.0',
	OTEL_EXPORTER_OTLP_ENDPOINT: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
	OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
	OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
	OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT,
	SIGNOZ_INGESTION_KEY: process.env.SIGNOZ_INGESTION_KEY,
	COINGECKO_API_KEY: process.env.COINGECKO_API_KEY,
	IS_COINGECKO_DEMO: process.env.IS_COINGECKO_DEMO?.toLowerCase() === 'true',
	LOW_BALANCE_DEFAULT_RULES_MAINNET: lowBalanceDefaultRulesMainnet,
	LOW_BALANCE_DEFAULT_RULES_PREPROD: lowBalanceDefaultRulesPreprod,
	// Prisma span filtering: only export outlier (slow) queries and cap volume
	OTEL_PRISMA_OUTLIER_THRESHOLD_MS: parseNumberEnv(
		'OTEL_PRISMA_OUTLIER_THRESHOLD_MS',
		process.env.OTEL_PRISMA_OUTLIER_THRESHOLD_MS,
		'100',
		0,
	),
	OTEL_PRISMA_MAX_SPANS_PER_MINUTE: parseNumberEnv(
		'OTEL_PRISMA_MAX_SPANS_PER_MINUTE',
		process.env.OTEL_PRISMA_MAX_SPANS_PER_MINUTE,
		'60',
		0,
	),
	// Orphan-action cleanup cron. Periodically prunes PaymentActionData /
	// PurchaseActionData rows that were created by a batch service's
	// pre-submit then orphaned by a rollback drift-check that refused to
	// delete them (per the "leak the row, do not corrupt history" safety
	// rule in the rollback paths). Daily by default; minimum-age guard
	// keeps in-flight requests from being clobbered.
	ORPHAN_ACTION_CLEANUP_INTERVAL_SECONDS: Math.max(
		3600,
		parseNumberEnv(
			'ORPHAN_ACTION_CLEANUP_INTERVAL_SECONDS',
			process.env.ORPHAN_ACTION_CLEANUP_INTERVAL_SECONDS,
			String(24 * 3600),
			0,
		),
	),
	ORPHAN_ACTION_CLEANUP_MIN_AGE_HOURS: Math.max(
		1,
		parseNumberEnv('ORPHAN_ACTION_CLEANUP_MIN_AGE_HOURS', process.env.ORPHAN_ACTION_CLEANUP_MIN_AGE_HOURS, '72', 0),
	),
	ORPHAN_ACTION_CLEANUP_BATCH_SIZE: Math.max(
		10,
		parseNumberEnv('ORPHAN_ACTION_CLEANUP_BATCH_SIZE', process.env.ORPHAN_ACTION_CLEANUP_BATCH_SIZE, '500', 0),
	),
	// SimpleApi / x402 registry sync
	SIMPLE_API_SYNC_INTERVAL: simpleApiSyncInterval,
	REGISTRY_SERVICE_URL: registryServiceUrl,
	REGISTRY_API_KEY: registryApiKey,
	X402_FACILITATOR_URL: x402FacilitatorUrl,
	X402_FACILITATOR_URL_IS_EXPLICIT: x402FacilitatorUrlIsExplicit,
};

export const CONSTANTS = {
	REVEAL_DATA_VALIDITY_TIME: 1000 * 60 * 60 * 2,
	DEFAULT_MAX_PARALLEL_TRANSACTIONS_EXTENDED_LOOKUP: 50,
	MUTEX_TIMEOUT_MINUTES: 3,
	MIN_COLLATERAL_LOVELACE: 1435230n,
	MIN_TX_FEE_BUFFER_LOVELACE: 2000000n,
	MAX_DEFAULT_SMART_CONTRACT_HISTORY_LEVELS: 10,

	FALLBACK_COINS_PER_UTXO_SIZE: 4310,

	RESULT_HASH_SIZE_BYTES: 65,
	TRANSACTION_TIMEOUTS: {
		SERIALIZABLE: 15000,
	},
	TRANSACTION_WAIT: {
		SERIALIZABLE: 15000,
	},
	RETRY_CONFIG: {
		MAX_RETRIES: 5,
		BACKOFF_MULTIPLIER: 2,
		INITIAL_DELAY_MS: 500,
		MAX_DELAY_MS: 15000,
	},
} as const;

export const SERVICE_CONSTANTS = {
	// Unified retry configuration for all services
	RETRY: {
		maxRetries: 5,
		backoffMultiplier: 5,
		initialDelayMs: 500,
		maxDelayMs: 7500,
	},

	// Common transaction settings
	TRANSACTION: {
		timeBufferMs: 300000, // ±5 minutes buffer for all transactions
		blockTimeBufferMs: 60000, // 1 minute block time buffer
		validitySlotBuffer: 30,
		resultTimeSlotBuffer: 18,
	},

	// Smart contract constants
	SMART_CONTRACT: {
		collateralAmount: '5000000', // 5 ADA collateral
		mintQuantity: '1',
		defaultExUnits: { mem: 7000000, steps: 3000000000 },
	},

	// Metadata labels
	METADATA: {
		nftLabel: 721, // Standard NFT metadata
		masumiLabel: 674, // Masumi-specific metadata
	},

	// Cardano native token identifier
	CARDANO: {
		NATIVE_TOKEN: 'lovelace', // ADA's smallest unit identifier
	},
} as const;

export const DEFAULTS = {
	DEFAULT_ADMIN_KEY: 'DefaultUnsecureAdminKey',
	TX_TIMEOUT_INTERVAL: 1000 * 60 * 7, // 7 minutes in seconds
	DEFAULT_METADATA_VERSION: 1,
	DEFAULT_REGISTRY_METADATA_VERSION: 2,
	DEFAULT_ADMIN_SIGNATURES_V2: 2,
	DEFAULT_IMAGE: 'ipfs://QmXXW7tmBgpQpXoJMAMEXXFe9dyQcrLFKGuzxnHDnbKC7f',

	ADMIN_WALLET1_PREPROD:
		'addr_test1qr7pdg0u7vy6a5p7cx9my9m0t63f4n48pwmez30t4laguawge7xugp6m5qgr6nnp6wazurtagjva8l9fc3a5a4scx0rq2ymhl3',
	ADMIN_WALLET2_PREPROD:
		'addr_test1qplhs9snd92fmr3tzw87uujvn7nqd4ss0fn8yz7mf3y2mf3a3806uqngr7hvksqvtkmetcjcluu6xeguagwyaxevdhmsuycl5a',
	ADMIN_WALLET3_PREPROD:
		'addr_test1qzy7a702snswullyjg06j04jsulldc6yw0m4r4w49jm44f30pgqg0ez34lrdj7dy7ndp2lgv8e35e6jzazun8gekdlsq99mm6w',
	FEE_WALLET_PREPROD:
		'addr_test1qqfuahzn3rpnlah2ctcdjxdfl4230ygdar00qxc32guetexyg7nun6hggw9g2gpnayzf22sksr0aqdgkdcvqpc2stwtqt4u496',
	FEE_PERMILLE_PREPROD: 50, //equals simulated 5% fee for the network

	COOLDOWN_TIME_PREPROD: 1000 * 60 * 7,

	ADMIN_WALLET1_MAINNET:
		'addr1q87pdg0u7vy6a5p7cx9my9m0t63f4n48pwmez30t4laguawge7xugp6m5qgr6nnp6wazurtagjva8l9fc3a5a4scx0rqfjxhnw',
	ADMIN_WALLET2_MAINNET:
		'addr1q9lhs9snd92fmr3tzw87uujvn7nqd4ss0fn8yz7mf3y2mf3a3806uqngr7hvksqvtkmetcjcluu6xeguagwyaxevdhmslj9lcz',
	ADMIN_WALLET3_MAINNET:
		'addr1qxy7a702snswullyjg06j04jsulldc6yw0m4r4w49jm44f30pgqg0ez34lrdj7dy7ndp2lgv8e35e6jzazun8gekdlsqxnxmk3',
	FEE_WALLET_MAINNET:
		'addr1qyfuahzn3rpnlah2ctcdjxdfl4230ygdar00qxc32guetexyg7nun6hggw9g2gpnayzf22sksr0aqdgkdcvqpc2stwtqgrp4f9',
	FEE_PERMILLE_MAINNET: 50, //equals 5% fee for the network

	PAYMENT_SMART_CONTRACT_ADDRESS_PREPROD: 'addr_test1wz7j4kmg2cs7yf92uat3ed4a3u97kr7axxr4avaz0lhwdsqukgwfm',
	REGISTRY_POLICY_ID_PREPROD: '7e8bdaf2b2b919a3a4b94002cafb50086c0c845fe535d07a77ab7f77',
	PAYMENT_SMART_CONTRACT_ADDRESS_MAINNET: 'addr1wx7j4kmg2cs7yf92uat3ed4a3u97kr7axxr4avaz0lhwdsq87ujx7',
	REGISTRY_POLICY_ID_MAINNET: 'ad6424e3ce9e47bbd8364984bd731b41de591f1d11f6d7d43d0da9b9',
	// Web3CardanoV2 defaults (Aiken v1.1.23 + CIP-30 admin signatures with
	// raw + CIP-8 hashed payload modes). Derived from ADMIN_WALLET{1,2,3}_*,
	// DEFAULT_ADMIN_SIGNATURES_V2, COOLDOWN_TIME_*.
	// See docs/migrations/v2-contract-cip30-upgrade.md when these change.
	PAYMENT_SMART_CONTRACT_ADDRESS_V2_PREPROD: 'addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g',
	REGISTRY_POLICY_ID_V2_PREPROD: '67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b',
	PAYMENT_SMART_CONTRACT_ADDRESS_V2_MAINNET: 'addr1wxs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgge2j6d',
	REGISTRY_POLICY_ID_V2_MAINNET: '67ab0c92c4ac1610895a1c965ee50aba41a8f1513b15240723b3bd0b',
	COOLDOWN_TIME_MAINNET: 1000 * 60 * 7,
};
