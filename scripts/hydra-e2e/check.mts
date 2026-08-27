/**
 * Assertion recorder.
 *
 * Records rather than throws, so one failing expectation does not hide the
 * twenty after it. The run still exits non-zero if anything failed — the point
 * is to see the whole picture in one pass, which is what makes a long
 * multi-process run worth doing at all.
 */

export type CheckResult = { phase: string; label: string; ok: boolean; detail: string };

const results: CheckResult[] = [];
let currentPhase = 'setup';

export function phase(name: string): void {
	currentPhase = name;
	console.log(`\n[1m── ${name} ──[0m`);
}

export function check(label: string, ok: boolean, detail = ''): boolean {
	results.push({ phase: currentPhase, label, ok, detail });
	const mark = ok ? '[32mPASS[0m' : '[31mFAIL[0m';
	console.log(`  ${mark}  ${label}${detail.length > 0 ? `  [2m${detail}[0m` : ''}`);
	return ok;
}

export function equals(label: string, actual: unknown, expected: unknown): boolean {
	const ok = actual === expected;
	return check(label, ok, ok ? String(actual) : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** Record a phase that could not run, so a skipped area is never mistaken for a passing one. */
export function skip(label: string, reason: string): void {
	results.push({ phase: currentPhase, label, ok: true, detail: `SKIPPED: ${reason}` });
	console.log(`  [33mSKIP[0m  ${label}  [2m${reason}[0m`);
}

export function failed(): CheckResult[] {
	return results.filter((result) => !result.ok);
}

export function summarise(): number {
	const bad = failed();
	const byPhase = new Map<string, { pass: number; fail: number }>();
	for (const result of results) {
		const entry = byPhase.get(result.phase) ?? { pass: 0, fail: 0 };
		if (result.ok) {
			entry.pass += 1;
		} else {
			entry.fail += 1;
		}
		byPhase.set(result.phase, entry);
	}

	console.log('\n[1m═══ summary ═══[0m');
	for (const [name, entry] of byPhase) {
		const status = entry.fail === 0 ? '[32mok[0m' : `[31m${entry.fail} failed[0m`;
		console.log(`  ${name.padEnd(28)} ${String(entry.pass).padStart(3)} passed  ${status}`);
	}
	console.log(`\n  total ${results.length}, failed ${bad.length}`);
	for (const result of bad) {
		console.log(`  [31m✗[0m ${result.phase} / ${result.label}: ${result.detail}`);
	}
	return bad.length === 0 ? 0 : 1;
}
