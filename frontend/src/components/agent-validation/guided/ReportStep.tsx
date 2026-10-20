import { Copy, Download, RotateCcw } from 'lucide-react';
import { toast } from 'react-toastify';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { summarizeChecks } from '@/lib/agent-validation/checks';
import { buildReport, reportVerdict } from '@/lib/agent-validation/report';
import { STEP_LABELS, allResults } from '@/lib/agent-validation/wizard';
import { copyToClipboard } from '@/lib/utils';
import { CheckList } from '../CheckList';
import { StepFrame } from './StepFrame';
import type { WizardApi } from './useWizard';

const VERDICT_VIEW = {
  fail: {
    label: 'Needs fixes',
    variant: 'destructive',
    text: 'Some checks failed. Fix them and run the steps again.',
  },
  warn: {
    label: 'Passed with warnings',
    variant: 'warning',
    text: 'Nothing is broken, but some things are worth a look.',
  },
  pass: {
    label: 'All checks passed',
    variant: 'success',
    text: 'Everything that was checked looks good.',
  },
  empty: {
    label: 'Nothing checked yet',
    variant: 'secondary',
    text: 'Go back and run some steps to fill the report.',
  },
} as const;

/** What was checked, what needs fixing, and a markdown copy to share. */
export function ReportStep({ wizard }: { wizard: WizardApi }) {
  const { state } = wizard;
  const results = allResults(state).filter(
    (entry) => entry.step !== 'intent' && entry.step !== 'report',
  );
  const verdict = reportVerdict(state);
  const view = VERDICT_VIEW[verdict];

  async function copy() {
    const copied = await copyToClipboard(buildReport(state, new Date().toISOString()));
    if (copied) toast.success('Report copied');
    else toast.error('Failed to copy the report');
  }

  function download() {
    const blob = new Blob([buildReport(state, new Date().toISOString())], {
      type: 'text/markdown',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `agent-validation-${state.network.toLowerCase()}.md`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <StepFrame title="Your report" description={view.text}>
      <div className="flex flex-wrap items-center gap-2" role="status">
        <Badge variant={view.variant}>{view.label}</Badge>
        <span className="text-xs text-muted-foreground">{state.network}</span>
      </div>

      {results.map((result) => {
        const summary = summarizeChecks(result.checks);
        return (
          <section
            key={result.step}
            className="space-y-2"
            aria-labelledby={`report-${result.step}`}
          >
            <h2 id={`report-${result.step}`} className="text-sm font-semibold">
              {STEP_LABELS[result.step]}
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {summary.fail} failed · {summary.warn} {summary.warn === 1 ? 'warning' : 'warnings'}{' '}
                · {summary.pass} passed
                {result.acknowledged ? ' · continued anyway' : ''}
              </span>
            </h2>
            <CheckList checks={result.checks} showSummary={false} foldPassed />
          </section>
        );
      })}

      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={copy} disabled={verdict === 'empty'}>
          <Copy aria-hidden />
          Copy report
        </Button>
        <Button type="button" variant="outline" onClick={download} disabled={verdict === 'empty'}>
          <Download aria-hidden />
          Download .md
        </Button>
        <Button type="button" variant="ghost" onClick={wizard.restart}>
          <RotateCcw aria-hidden />
          Start over
        </Button>
      </div>
    </StepFrame>
  );
}
