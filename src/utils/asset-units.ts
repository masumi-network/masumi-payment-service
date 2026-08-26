export const MAINNET_USDCX_UNIT = '1f3aec8bfe7ea4fe14c5f121e2a92e301afe414147860d557cac7e345553444378';
export const MAINNET_USDM_UNIT = 'c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad0014df105553444d';
export const PREPROD_USDM_UNIT = '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d';

type ReportAssetKey = 'ada' | 'usdm' | 'usdcx' | 'fiat';

export type ReportAssetMetadata = {
	key: ReportAssetKey;
	symbol: string;
	decimals: 6;
};

/**
 * Converted money is carried as a synthetic unit, so it travels through the
 * same amount, aggregate, and serialization paths as any on-chain asset.
 */
export const FIAT_UNIT_PREFIX = 'fiat:';

export function isFiatAssetUnit(unit: string): boolean {
	return unit.startsWith(FIAT_UNIT_PREFIX);
}

export function fiatAssetUnit(currency: string): string {
	return `${FIAT_UNIT_PREFIX}${currency.toLowerCase()}`;
}

export function getFiatCurrency(unit: string): string | null {
	return isFiatAssetUnit(unit) ? unit.slice(FIAT_UNIT_PREFIX.length) : null;
}

const ADA_METADATA: ReportAssetMetadata = { key: 'ada', symbol: 'ADA', decimals: 6 };
const USDM_METADATA: ReportAssetMetadata = { key: 'usdm', symbol: 'USDM', decimals: 6 };
const USDCX_METADATA: ReportAssetMetadata = { key: 'usdcx', symbol: 'USDCx', decimals: 6 };

export function normalizeAssetUnit(unit: string): string {
	return unit === '' || unit.toLowerCase() === 'lovelace' ? 'lovelace' : unit;
}

export function getReportAssetMetadata(unit: string): ReportAssetMetadata | null {
	const normalizedUnit = normalizeAssetUnit(unit);
	const fiatCurrency = getFiatCurrency(normalizedUnit);
	if (fiatCurrency != null) return { key: 'fiat', symbol: fiatCurrency.toUpperCase(), decimals: 6 };
	if (normalizedUnit === 'lovelace') return ADA_METADATA;
	if (normalizedUnit === MAINNET_USDM_UNIT || normalizedUnit === PREPROD_USDM_UNIT) return USDM_METADATA;
	if (normalizedUnit === MAINNET_USDCX_UNIT) return USDCX_METADATA;
	return null;
}

export function atomicToDecimalString(amount: bigint, decimals: number): string {
	if (!Number.isInteger(decimals) || decimals < 0) {
		throw new RangeError('decimals must be a non-negative integer');
	}

	const isNegative = amount < 0n;
	const absoluteAmount = isNegative ? -amount : amount;
	const divisor = 10n ** BigInt(decimals);
	const whole = absoluteAmount / divisor;
	const fraction = (absoluteAmount % divisor).toString().padStart(decimals, '0');
	const sign = isNegative ? '-' : '';
	return decimals === 0 ? `${sign}${whole}` : `${sign}${whole}.${fraction}`;
}

export function serializeReportAmount(value: { unit: string; amount: bigint }) {
	const unit = normalizeAssetUnit(value.unit);
	const metadata = getReportAssetMetadata(unit);
	return {
		unit,
		rawAmount: value.amount.toString(),
		decimalAmount: metadata == null ? null : atomicToDecimalString(value.amount, metadata.decimals),
		decimals: metadata?.decimals ?? null,
		symbol: metadata?.symbol ?? null,
	};
}
