import type { AgentValidationCheck } from '@/lib/api/generated';

/** One finding. The same shape comes from the backend probe and from checks computed in the browser. */
export type ValidationCheck = AgentValidationCheck;
export type CheckStatus = ValidationCheck['status'];

/** `empty` means nothing was actually checked (no checks, or all skipped), which must not read as a pass. */
export type Verdict = 'fail' | 'warn' | 'pass' | 'empty';

export type CheckSummary = {
  pass: number;
  warn: number;
  fail: number;
  skipped: number;
  verdict: Verdict;
};

type CheckExtras = { detail?: string | null; fix?: string | null; docsUrl?: string | null };

/** Builds a finding in the browser, with the optional fields explicitly null like the API does. */
export function check(
  status: CheckStatus,
  id: string,
  label: string,
  extras: CheckExtras = {},
): ValidationCheck {
  return {
    id,
    status,
    label,
    detail: extras.detail ?? null,
    fix: extras.fix ?? null,
    docsUrl: extras.docsUrl ?? null,
  };
}

export function summarizeChecks(checks: readonly ValidationCheck[]): CheckSummary {
  const summary: CheckSummary = { pass: 0, warn: 0, fail: 0, skipped: 0, verdict: 'empty' };
  for (const entry of checks) {
    summary[entry.status] += 1;
  }
  if (summary.fail > 0) summary.verdict = 'fail';
  else if (summary.warn > 0) summary.verdict = 'warn';
  else if (summary.pass > 0) summary.verdict = 'pass';
  return summary;
}

const STATUS_ORDER: Record<CheckStatus, number> = { fail: 0, warn: 1, skipped: 2, pass: 3 };

/** Failures and warnings first, so the thing to fix is never below the fold. Stable within a status. */
export function problemsFirst(checks: readonly ValidationCheck[]): ValidationCheck[] {
  return checks
    .map((entry, index) => ({ entry, index }))
    .sort(
      (a, b) => STATUS_ORDER[a.entry.status] - STATUS_ORDER[b.entry.status] || a.index - b.index,
    )
    .map(({ entry }) => entry);
}

export function hasFailures(checks: readonly ValidationCheck[]): boolean {
  return checks.some((entry) => entry.status === 'fail');
}
