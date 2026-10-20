import { problemsFirst, summarizeChecks, type CheckStatus, type Verdict } from './checks';
import { STEP_LABELS, allResults, stepsFor, type StepId, type WizardState } from './wizard';

/** A copyable markdown summary of a wizard run, for a ticket, a chat message or a pull request. */

const NOT_A_SECTION: ReadonlySet<StepId> = new Set(['intent', 'report']);

const VERDICT_TEXT: Record<Verdict, string> = {
  fail: 'FAILED',
  warn: 'PASSED WITH WARNINGS',
  pass: 'PASSED',
  empty: 'NOT RUN',
};

const STATUS_TAG: Record<CheckStatus, string> = {
  pass: 'PASS',
  warn: 'WARN',
  fail: 'FAIL',
  skipped: 'SKIP',
};

const plural = (count: number, singular: string, pluralForm = `${singular}s`) =>
  `${count} ${count === 1 ? singular : pluralForm}`;

export function reportVerdict(state: WizardState): Verdict {
  return summarizeChecks(allResults(state).flatMap((result) => result.checks)).verdict;
}

function subjectLine(state: WizardState): string {
  return state.answers.subject === 'coworker'
    ? 'Sokosumi coworker'
    : `Masumi agent (${state.answers.agentType})`;
}

export function buildReport(state: WizardState, generatedAt: string): string {
  const results = allResults(state);
  const summary = summarizeChecks(results.flatMap((result) => result.checks));
  const { answers } = state;

  const lines = [
    '# Agent validation report',
    '',
    `Network: ${state.network}`,
    `Generated: ${generatedAt}`,
    `Subject: ${subjectLine(state)}`,
    ...(answers.apiBaseUrl ? [`URL: ${answers.apiBaseUrl}`] : []),
    ...(answers.agentIdentifier ? [`Agent identifier: ${answers.agentIdentifier}`] : []),
    '',
    `Overall: ${VERDICT_TEXT[summary.verdict]}`,
    `${summary.pass} passed, ${plural(summary.warn, 'warning')}, ${plural(summary.fail, 'failure')}`,
  ];

  for (const result of results.filter((entry) => !NOT_A_SECTION.has(entry.step))) {
    const stepSummary = summarizeChecks(result.checks);
    const suffix =
      stepSummary.verdict === 'fail'
        ? ` (failed${result.acknowledged ? ', continued anyway' : ''})`
        : stepSummary.verdict === 'warn'
          ? ' (warnings)'
          : stepSummary.verdict === 'pass'
            ? ' (passed)'
            : '';
    lines.push('', `## ${STEP_LABELS[result.step]}${suffix}`, '');
    for (const entry of problemsFirst(result.checks)) {
      lines.push(
        `- [${STATUS_TAG[entry.status]}] ${entry.label}${entry.detail ? ` - ${entry.detail}` : ''}`,
      );
      if (entry.fix) lines.push(`  Fix: ${entry.fix}`);
      if (entry.docsUrl) lines.push(`  Docs: ${entry.docsUrl}`);
    }
  }

  const notRun = stepsFor(answers, state.network).filter(
    (step) => !NOT_A_SECTION.has(step) && state.results[step] == null,
  );
  if (notRun.length > 0) {
    lines.push('', `Not run: ${notRun.map((step) => STEP_LABELS[step]).join(', ')}`);
  }
  return `${lines.join('\n')}\n`;
}
