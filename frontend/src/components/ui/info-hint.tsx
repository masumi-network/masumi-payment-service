/**
 * A short explanation attached to a label, opened on demand.
 *
 * Some of what this dashboard shows cannot be understood from its label alone:
 * a dispute window, an out-of-sync limit, a deposit that is on chain but not
 * yet spendable. Spelling those out inline turned screens into documentation,
 * and leaving them out left an operator guessing at a number they were being
 * asked to choose.
 *
 * A popover rather than a tooltip, deliberately: hover explanations are
 * unreachable by touch, and a tooltip that vanishes when the pointer moves is
 * no use for text long enough to be worth reading.
 */

import type { ReactNode } from 'react';
import { Info } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

export function InfoHint({
  label,
  children,
  className,
}: {
  /**
   * What is being explained, e.g. "dispute window". Read out as "What is the
   * dispute window?", so screen-reader users get the same cue as the icon.
   */
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Popover>
      <PopoverTrigger
        type="button"
        aria-label={`What is the ${label}?`}
        className={cn(
          // The icon is small on purpose, the target is not: the padding gives
          // it a hit area a finger can reach without crowding the label.
          '-m-2 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full p-2 align-middle',
          'text-muted-foreground transition-colors hover:text-foreground',
          'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden',
          className,
        )}
      >
        <Info className="h-3.5 w-3.5" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-72 space-y-2 p-3 text-sm leading-relaxed text-muted-foreground"
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}
