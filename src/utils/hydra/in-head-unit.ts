const LOVELACE_UNITS = new Set(['', 'lovelace']);

/** The unit an in-head balance keys an asset by: ADA is '', whether written '' or 'lovelace'. */
export function inHeadUnit(unit: string): string {
	return LOVELACE_UNITS.has(unit.toLowerCase()) ? '' : unit;
}
