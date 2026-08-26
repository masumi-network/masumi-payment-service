// Asset unit names used when an invoice prints a conversion rate. They live in
// their own file so the invoice text and the invoice HTML can both read them
// without importing each other.
export const MAINNET_USDCX_UNIT = '1f3aec8bfe7ea4fe14c5f121e2a92e301afe414147860d557cac7e345553444378';
export const MAINNET_USDM_UNIT = 'c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad0014df105553444d';
export const PREPROD_USDM_UNIT = '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d';

export function formatCryptoUnitConversion(convertedUnit: string, conversionFactor: string) {
	let unitName = convertedUnit;
	if (convertedUnit === '') {
		unitName = 'ADA';
	} else if (convertedUnit === MAINNET_USDCX_UNIT) {
		unitName = 'USDCx';
	} else if (convertedUnit === MAINNET_USDM_UNIT) {
		unitName = 'USDM';
	} else if (convertedUnit === PREPROD_USDM_UNIT) {
		unitName = 'tUSDM';
	}
	return ` ${conversionFactor} ${unitName}`;
}
