import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import type { ProbeResult } from '@/lib/hooks/useAgentValidationApi';

function statusBadge(httpStatus: number | null) {
  if (httpStatus == null) return <Badge variant="secondary">No response</Badge>;
  if (httpStatus >= 200 && httpStatus < 300)
    return <Badge variant="success">HTTP {httpStatus}</Badge>;
  if (httpStatus >= 300 && httpStatus < 400)
    return <Badge variant="warning">HTTP {httpStatus}</Badge>;
  return <Badge variant="destructive">HTTP {httpStatus}</Badge>;
}

function prettyBody(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** What the agent actually answered: status, timing, redirect target and the body. */
export function ResponseDetails({ probe }: { probe: ProbeResult }) {
  return (
    <div className="space-y-2 rounded-lg border px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium">Agent response</span>
        {statusBadge(probe.httpStatus)}
        {probe.httpStatus != null && (
          <span className="text-xs text-muted-foreground">{probe.durationMs} ms</span>
        )}
      </div>
      {probe.redirectedTo && (
        <p className="break-all text-xs text-muted-foreground">
          Redirects to <span className="font-mono">{probe.redirectedTo}</span> (not followed)
        </p>
      )}
      {probe.bodyText ? (
        <Collapsible>
          <CollapsibleTrigger className="text-xs font-medium text-muted-foreground hover:text-foreground">
            Show response body
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre className="mt-2 max-h-72 overflow-auto rounded-md bg-muted p-3 text-xs">
              {prettyBody(probe.bodyText)}
            </pre>
            {probe.bodyText.length >= 20_000 && (
              <p className="mt-1 text-xs text-muted-foreground">
                Showing the first 20,000 characters.
              </p>
            )}
          </CollapsibleContent>
        </Collapsible>
      ) : (
        probe.httpStatus != null && (
          <p className="text-xs text-muted-foreground">The response had no body.</p>
        )
      )}
    </div>
  );
}
