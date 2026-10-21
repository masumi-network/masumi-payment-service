import { AlertTriangle, CheckCircle2, ExternalLink, MinusCircle, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  problemsFirst,
  summarizeChecks,
  type CheckStatus,
  type ValidationCheck,
  type Verdict,
} from '@/lib/agent-validation/checks';
import { splitLinks } from '@/lib/agent-validation/linkify';
import { cn } from '@/lib/utils';

const STATUS_VIEW: Record<CheckStatus, { label: string; icon: typeof XCircle; className: string }> =
  {
    fail: { label: 'Failed', icon: XCircle, className: 'text-destructive' },
    warn: {
      label: 'Warning',
      icon: AlertTriangle,
      className: 'text-amber-600 dark:text-amber-400',
    },
    pass: { label: 'Passed', icon: CheckCircle2, className: 'text-green-600 dark:text-green-400' },
    skipped: { label: 'Skipped', icon: MinusCircle, className: 'text-muted-foreground' },
  };

const VERDICT_BADGE: Record<
  Verdict,
  { label: string; variant: 'destructive' | 'warning' | 'success' | 'secondary' }
> = {
  fail: { label: 'Needs fixes', variant: 'destructive' },
  warn: { label: 'Passed with warnings', variant: 'warning' },
  pass: { label: 'All checks passed', variant: 'success' },
  empty: { label: 'Nothing checked yet', variant: 'secondary' },
};

/** Text that may mention URLs (faucets, docs): http(s) links become anchors, everything else stays text. */
export function LinkedText({ text }: { text: string }) {
  return (
    <>
      {splitLinks(text).map((segment, index) =>
        segment.type === 'link' ? (
          <a
            key={index}
            href={segment.href}
            target="_blank"
            rel="noreferrer"
            className="break-all underline decoration-muted-foreground/50 underline-offset-2 hover:decoration-foreground"
          >
            {segment.href}
          </a>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}

function CheckRow({ entry }: { entry: ValidationCheck }) {
  const view = STATUS_VIEW[entry.status];
  const Icon = view.icon;
  return (
    <li className="flex gap-3 px-4 py-3">
      <Icon className={cn('mt-0.5 size-4 shrink-0', view.className)} aria-hidden />
      <div className="min-w-0 flex-1 space-y-1.5">
        <p className="text-sm font-medium">
          <span className="sr-only">{view.label}: </span>
          {entry.label}
        </p>
        {entry.detail && (
          <p className="break-words text-sm text-muted-foreground">
            <LinkedText text={entry.detail} />
          </p>
        )}
        {entry.fix && (
          <div className="rounded-md border border-dashed bg-muted/40 px-3 py-2 text-sm">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              How to fix
            </p>
            <p className="mt-0.5 break-words">
              <LinkedText text={entry.fix} />
            </p>
          </div>
        )}
        {entry.docsUrl && (
          <a
            href={entry.docsUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-primary underline-offset-2 hover:underline"
          >
            Documentation
            <ExternalLink className="size-3" aria-hidden />
          </a>
        )}
      </div>
    </li>
  );
}

/**
 * Findings, problems first. Passed checks are folded away when something needs attention, so the thing to
 * fix is never buried, and open when everything is fine so the developer can see what was covered.
 */
export function CheckList({
  checks,
  emptyText = 'No checks have run yet.',
  className,
  foldPassed = false,
  showSummary = true,
}: {
  checks: readonly ValidationCheck[];
  emptyText?: string;
  className?: string;
  /** Keep passed checks folded even when everything passed, for long lists inside a larger flow. */
  foldPassed?: boolean;
  /** Hide the verdict line when the surrounding page already states it. */
  showSummary?: boolean;
}) {
  const summary = summarizeChecks(checks);
  const badge = VERDICT_BADGE[summary.verdict];
  const ordered = problemsFirst(checks);
  const open = ordered.filter((entry) => entry.status !== 'pass');
  const passed = ordered.filter((entry) => entry.status === 'pass');

  if (checks.length === 0) {
    return <p className={cn('text-sm text-muted-foreground', className)}>{emptyText}</p>;
  }

  return (
    <div className={cn('space-y-3', className)}>
      {showSummary && (
        <div className="flex flex-wrap items-center gap-2" role="status">
          <Badge variant={badge.variant}>{badge.label}</Badge>
          <span className="text-xs text-muted-foreground">
            {summary.fail} failed · {summary.warn} {summary.warn === 1 ? 'warning' : 'warnings'} ·{' '}
            {summary.pass} passed
            {summary.skipped > 0 ? ` · ${summary.skipped} skipped` : ''}
          </span>
        </div>
      )}
      <div className="divide-y rounded-lg border">
        {open.length > 0 && (
          <ul className="divide-y" aria-label="Checks that need attention">
            {open.map((entry) => (
              <CheckRow key={entry.id} entry={entry} />
            ))}
          </ul>
        )}
        {passed.length > 0 && (
          // Keyed so a re-run that changes whether anything needs attention resets the folded state.
          <Collapsible
            key={open.length === 0 ? 'clean' : 'attention'}
            defaultOpen={open.length === 0 && !foldPassed}
          >
            <CollapsibleTrigger className="w-full px-4 py-2.5 text-left text-xs font-medium text-muted-foreground hover:text-foreground">
              {passed.length} passed {passed.length === 1 ? 'check' : 'checks'}
            </CollapsibleTrigger>
            <CollapsibleContent>
              <ul className="divide-y border-t" aria-label="Passed checks">
                {passed.map((entry) => (
                  <CheckRow key={entry.id} entry={entry} />
                ))}
              </ul>
            </CollapsibleContent>
          </Collapsible>
        )}
      </div>
    </div>
  );
}
