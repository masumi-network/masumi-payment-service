/**
 * A collapsible block in the head details.
 *
 * The dialog had grown to eleven flat sections — identifiers, timestamps,
 * lifecycle transactions, participants, keys, balance, deposits, errors — all
 * at the same weight, so finding the one fact you came for meant reading all of
 * them. Most are reference material consulted rarely; only a few are read every
 * time.
 *
 * Sections carry a summary in their header so a collapsed one still answers the
 * question it exists for. Collapsing something that then hides whether it needs
 * attention would be worse than the wall of text it replaced.
 */

import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

export function HydraDetailSection({
  title,
  summary,
  defaultOpen = false,
  children,
}: {
  title: string;
  /** Shown in the header, so a collapsed section still says what is inside. */
  summary?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <Collapsible defaultOpen={defaultOpen} className="rounded-md border">
      <CollapsibleTrigger className="group flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-accent/50">
        <span className="flex items-center gap-2 font-medium">
          <ChevronDown
            className={cn(
              'h-4 w-4 text-muted-foreground transition-transform',
              'group-data-[state=closed]:-rotate-90',
            )}
          />
          {title}
        </span>
        {summary !== undefined && (
          <span className="truncate text-sm text-muted-foreground">{summary}</span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-4 border-t px-4 py-4">{children}</CollapsibleContent>
    </Collapsible>
  );
}
