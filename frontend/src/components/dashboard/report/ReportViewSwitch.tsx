import { cn } from '@/lib/utils';

/**
 * Sub-navigation inside the report. Deliberately not the page's underline
 * tabs: the dashboard already uses those one level up, and two identical tab
 * rows read as one broken row rather than as a hierarchy.
 */
export function ReportViewSwitch({
  views,
  activeView,
  onSelect,
}: Readonly<{
  views: readonly string[];
  activeView: string;
  onSelect: (view: string) => void;
}>) {
  return (
    <div
      role="tablist"
      aria-label="Report view"
      className="inline-flex flex-wrap gap-1 rounded-lg border p-1"
    >
      {views.map((view) => {
        const isActive = view === activeView;
        return (
          <button
            key={view}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onSelect(view)}
            className={cn(
              'rounded-md px-3 py-1.5 text-sm transition-colors',
              isActive
                ? 'bg-muted font-medium text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {view}
          </button>
        );
      })}
    </div>
  );
}
