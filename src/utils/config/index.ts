import dotenv from 'dotenv';
dotenv.config();
if (process.env.DATABASE_URL == null) throw new Error('Undefined DATABASE_URL ENV variable');
if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length <= 20)
	throw new Error('Undefined or unsecure ENCRYPTION_KEY ENV variable. Require min 20 char');

const batchPaymentInterval = Number(process.env.BATCH_PAYMENT_INTERVAL ?? '30');
if (batchPaymentInterval < 5) throw new Error('BATCH_PAYMENT_INTERVAL must be at least 5 seconds');
const checkTxInterval = Number(process.env.CHECK_TX_INTERVAL ?? '20');
if (checkTxInterval < 15) throw new Error('CHECK_TX_INTERVAL must be at least 15 seconds');
const checkCollectionInterval = Number(process.env.CHECK_COLLECTION_INTERVAL ?? '15');
if (checkCollectionInterval < 5) throw new Error('CHECK_COLLECTION_INTERVAL must be at least 5 seconds');
const checkCollectRefundInterval = Number(process.env.CHECK_COLLECT_REFUND_INTERVAL ?? '15');
if (checkCollectRefundInterval < 5) throw new Error('CHECK_COLLECT_REFUND_INTERVAL must be at least 5 seconds');
const checkSetRefundInterval = Number(process.env.CHECK_SET_REFUND_INTERVAL ?? '15');
if (checkSetRefundInterval < 5) throw new Error('CHECK_SET_REFUND_INTERVAL must be at least 5 seconds');
const checkUnsetRefundInterval = Number(process.env.CHECK_UNSET_REFUND_INTERVAL ?? '15');
if (checkUnsetRefundInterval < 5) throw new Error('CHECK_UNSET_REFUND_INTERVAL must be at least 5 seconds');
const checkWalletTransactionHashInterval = Number(process.env.CHECK_WALLET_TRANSACTION_HASH_INTERVAL ?? '20');
if (checkWalletTransactionHashInterval < 5)
	throw new Error('CHECK_WALLET_TRANSACTION_HASH_INTERVAL must be at least 5 seconds');
const checkAuthorizeRefundInterval = Number(process.env.CHECK_AUTHORIZE_REFUND_INTERVAL ?? '15');
if (checkAuthorizeRefundInterval < 5) throw new Error('CHECK_AUTHORIZE_REFUND_INTERVAL must be at least 5 seconds');
const checkSubmitResultInterval = Number(process.env.CHECK_SUBMIT_RESULT_INTERVAL ?? '15');
if (checkSubmitResultInterval < 5) throw new Error('CHECK_SUBMIT_RESULT_INTERVAL must be at least 5 seconds');
const registerAgentInterval = Number(process.env.REGISTER_AGENT_INTERVAL ?? '15');
if (registerAgentInterval < 5) throw new Error('REGISTER_AGENT_INTERVAL must be at least 5 seconds');
const deregisterAgentInterval = Number(process.env.DEREGISTER_AGENT_INTERVAL ?? '15');
if (deregisterAgentInterval < 5) throw new Error('DEREGISTER_AGENT_INTERVAL must be at least 5 seconds');

const autoWithdrawPayments =
	process.env.AUTO_WITHDRAW_PAYMENTS?.toLowerCase() === 'true' ||
	process.env.AUTO_WITHDRAW_PAYMENTS === '' ||
	process.env.AUTO_WITHDRAW_PAYMENTS == undefined;
const autoWithdrawRefunds =
	process.env.AUTO_WITHDRAW_REFUNDS?.toLowerCase() === 'true' ||
	process.env.AUTO_WITHDRAW_REFUNDS === '' ||
	process.env.AUTO_WITHDRAW_REFUNDS == undefined;

const checkRegistryTransactionsInterval = Number(process.env.CHECK_REGISTRY_TRANSACTIONS_INTERVAL ?? '15');
if (checkRegistryTransactionsInterval < 5)
	throw new Error('CHECK_REGISTRY_TRANSACTIONS_INTERVAL must be at least 5 seconds');

const autoDecisionInterval = Number(process.env.AUTO_DECISION_INTERVAL ?? '30');
if (autoDecisionInterval < 5) throw new Error('AUTO_DECISION_INTERVAL must be at least 5 seconds');

const webhookDeliveryInterval = Number(process.env.WEBHOOK_DELIVERY_INTERVAL ?? '10');
if (webhookDeliveryInterval < 5) throw new Error('WEBHOOK_DELIVERY_INTERVAL must be at least 5 seconds');

const blockConfirmationsThreshold = Number(process.env.BLOCK_CONFIRMATIONS_THRESHOLD ?? '1');
if (blockConfirmationsThreshold < 0) throw new Error('BLOCK_CONFIRMATIONS_THRESHOLD must be at least 0');

const syncLockTimeoutInterval = Number(process.env.SYNC_LOCK_TIMEOUT_INTERVAL ?? '300');
if (syncLockTimeoutInterval < 5) throw new Error('SYNC_LOCK_TIMEOUT_INTERVAL must be at least 5 seconds');

const walletLockTimeoutInterval = Number(process.env.WALLET_LOCK_TIMEOUT_INTERVAL ?? '300');
if (walletLockTimeoutInterval < 5) throw new Error('WALLET_LOCK_TIMEOUT_INTERVAL must be at least 5 seconds');

export const CONFIG = {
	PORT: process.env.PORT ?? '3001',
	DATABASE_URL: process.env.DATABASE_URL,
	SYNC_LOCK_TIMEOUT_INTERVAL: syncLockTimeoutInterval * 1000,
	WALLET_LOCK_TIMEOUT_INTERVAL: walletLockTimeoutInterval * 1000,
	BATCH_PAYMENT_INTERVAL: batchPaymentInterval,
	BLOCK_CONFIRMATIONS_THRESHOLD: blockConfirmationsThreshold,
	CHECK_TX_INTERVAL: checkTxInterval,
	CHECK_COLLECTION_INTERVAL: checkCollectionInterval,
	CHECK_COLLECT_REFUND_INTERVAL: checkCollectRefundInterval,
	CHECK_SET_REFUND_INTERVAL: checkSetRefundInterval,
	CHECK_UNSET_REFUND_INTERVAL: checkUnsetRefundInterval,
	CHECK_WALLET_TRANSACTION_HASH_INTERVAL: checkWalletTransactionHashInterval,
	CHECK_AUTHORIZE_REFUND_INTERVAL: checkAuthorizeRefundInterval,
	CHECK_SUBMIT_RESULT_INTERVAL: checkSubmitResultInterval,
	REGISTER_AGENT_INTERVAL: registerAgentInterval,
	DEREGISTER_AGENT_INTERVAL: deregisterAgentInterval,
	CHECK_REGISTRY_TRANSACTIONS_INTERVAL: checkRegistryTransactionsInterval,
	ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
	AUTO_WITHDRAW_PAYMENTS: autoWithdrawPayments,
	AUTO_WITHDRAW_REFUNDS: autoWithdrawRefunds,
	AUTO_DECISION_INTERVAL: autoDecisionInterval,
	WEBHOOK_DELIVERY_INTERVAL: webhookDeliveryInterval,
	// OpenTelemetry configuration
	OTEL_SERVICE_NAME: process.env.OTEL_SERVICE_NAME ?? 'masumi-payment-service',
	OTEL_SERVICE_VERSION: process.env.OTEL_SERVICE_VERSION ?? '0.1.0',
	OTEL_EXPORTER_OTLP_ENDPOINT: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
	OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
	OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
	OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT,
	SIGNOZ_INGESTION_KEY: process.env.SIGNOZ_INGESTION_KEY,
};

export const CONSTANTS = {
	REVEAL_DATA_VALIDITY_TIME: 1000 * 60 * 60 * 2,
	DEFAULT_MAX_PARALLEL_TRANSACTIONS_EXTENDED_LOOKUP: 50,
	MUTEX_TIMEOUT_MINUTES: 3,
	MIN_COLLATERAL_LOVELACE: 1435230n,
	MAX_DEFAULT_SMART_CONTRACT_HISTORY_LEVELS: 10,
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
		timeBufferMs: 150000, // ±2.5 minutes buffer for all transactions
		blockTimeBufferMs: 60000, // 1 minute block time buffer
		validitySlotBuffer: 5,
		resultTimeSlotBuffer: 3,
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

// ============================================================
// HYDRA L2 CONFIGURATION
// ============================================================

const hydraEnabled = process.env.HYDRA_ENABLED === 'true';
const hydraAutoOpenThreshold = parseInt(process.env.HYDRA_AUTO_OPEN_THRESHOLD ?? '10', 10);
const hydraAutoCloseIdleSeconds = parseInt(process.env.HYDRA_AUTO_CLOSE_IDLE_SECONDS ?? '3600', 10);
const hydraReconnectIntervalMs = parseInt(process.env.HYDRA_RECONNECT_INTERVAL_MS ?? '5000', 10);
const hydraMaxReconnectAttempts = parseInt(process.env.HYDRA_MAX_RECONNECT_ATTEMPTS ?? '10', 10);

export const HYDRA_CONFIG = {
	/**
	 * Enable/disable Hydra L2 routing globally
	 * When disabled, all transactions go to L1
	 */
	ENABLED: hydraEnabled,

	/**
	 * Default Hydra node WebSocket URL
	 * Can be overridden per PaymentSource
	 */
	DEFAULT_NODE_URL: process.env.HYDRA_NODE_URL ?? 'ws://127.0.0.1:4001',

	/**
	 * Default Hydra node HTTP URL
	 * Used for UTXO queries and commit operations
	 */
	DEFAULT_NODE_HTTP_URL: process.env.HYDRA_NODE_HTTP_URL ?? 'http://127.0.0.1:4001',

	/**
	 * Auto-open Hydra head after N transactions between same agents
	 * Set to 0 to disable auto-open
	 */
	AUTO_OPEN_THRESHOLD: hydraAutoOpenThreshold,

	/**
	 * Auto-close Hydra head after N seconds of inactivity
	 * Set to 0 to disable auto-close
	 */
	AUTO_CLOSE_IDLE_SECONDS: hydraAutoCloseIdleSeconds,

	/**
	 * WebSocket reconnection interval in milliseconds
	 */
	RECONNECT_INTERVAL_MS: hydraReconnectIntervalMs,

	/**
	 * Maximum WebSocket reconnection attempts
	 */
	MAX_RECONNECT_ATTEMPTS: hydraMaxReconnectAttempts,

	/**
	 * Enable debug logging for routing decisions
	 */
	DEBUG_LOGGING: process.env.HYDRA_DEBUG_LOGGING === 'true',

	/**
	 * Contestation period in seconds (for head closing)
	 * This is configured on the Hydra node, not here
	 * Listed for documentation purposes
	 */
	CONTESTATION_PERIOD_INFO: 'Configured on Hydra node (default: 60 seconds for testnet)',
} as const;

export const DEFAULTS = {
	DEFAULT_ADMIN_KEY: 'DefaultUnsecureAdminKey',
	TX_TIMEOUT_INTERVAL: 1000 * 60 * 7, // 7 minutes in seconds
	DEFAULT_METADATA_VERSION: 1,
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
	COOLDOWN_TIME_MAINNET: 1000 * 60 * 7,
};
