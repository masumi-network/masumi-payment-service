import 'dotenv/config';

const ADA = 1_000_000n;
const COSIGN_TIMEOUT_MS = 10_000;

// Datum policy the owner sets at mint (MAS-596 P0 item 2: per wallet, operator-chosen).
export const WALLET_PERIOD_MS = 24n * 60n * 60n * 1000n;
export const WALLET_MIN_BALANCE_LOVELACE = 5n * ADA;
export const AGENT_COLLATERAL_SPLIT_LOVELACE = 10n * ADA;

// ---------------------------------------------------------------- config

function intEnv(name: string, fallback: number, min: number, max: number): number {
	const raw = process.env[name]?.trim();
	const value = raw == null || raw === '' ? fallback : Number(raw);
	if (!Number.isSafeInteger(value) || value < min || value > max) {
		throw new Error(`${name} must be an integer between ${min} and ${max}`);
	}
	return value;
}

function lovelaceEnv(name: string, fallback: bigint): bigint {
	const raw = process.env[name]?.trim();
	if (raw == null || raw === '') return fallback;
	if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a lovelace integer`);
	return BigInt(raw);
}

function listEnv(name: string): string[] {
	return (process.env[name] ?? '')
		.split(',')
		.map((value) => value.trim().toLowerCase())
		.filter(Boolean);
}

export function requiredEnv(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
}

export const config = {
	purchases: intEnv('SMART_WALLET_DEMO_N', 10, 1, 10),
	threshold: intEnv('SMART_WALLET_DEMO_QUORUM_THRESHOLD', 2, 1, 16),
	mockPort: intEnv('SMART_WALLET_DEMO_MOCK_PORT', 4600, 1, 65_535),
	lockLovelace: lovelaceEnv('SMART_WALLET_DEMO_LOCK_LOVELACE', 6n * ADA),
	denyLockLovelace: lovelaceEnv('SMART_WALLET_DEMO_DENY_LOCK_LOVELACE', 8n * ADA),
	mockCapLovelace: lovelaceEnv('SMART_WALLET_DEMO_MOCK_CAP_LOVELACE', 70n * ADA),
	fundLovelace: lovelaceEnv('SMART_WALLET_DEMO_FUND_LOVELACE', 150n * ADA),
	cosignUrl: process.env.EXCHAIN_COSIGN_URL?.trim() || null,
	cosignApiKey: process.env.EXCHAIN_COSIGN_API_KEY?.trim() || null,
	cosignQuorumVkhs: listEnv('EXCHAIN_COSIGN_QUORUM_VKHS'),
	cosignTimeoutMs: intEnv('EXCHAIN_COSIGN_TIMEOUT_MS', COSIGN_TIMEOUT_MS, 100, 120_000),
	trustedPlaintextHosts: listEnv('EXCHAIN_COSIGN_TRUSTED_PLAINTEXT_HOSTS'),
};

/** The owner must choose the validator period limit before a new mint. */
export function walletPeriodLimitLovelace(): bigint {
	const name = 'SMART_WALLET_DEMO_PERIOD_LIMIT_LOVELACE';
	const raw = requiredEnv(name);
	if (!/^\d+$/.test(raw) || BigInt(raw) <= 0n) {
		throw new Error(`${name} must be a positive lovelace integer`);
	}
	return BigInt(raw);
}
