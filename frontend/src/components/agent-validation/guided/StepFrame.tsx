import type { ReactNode } from 'react';

/** Title, one-line purpose and content of a wizard step. The title is focused after each step change. */
export function StepFrame({
  title,
  description,
  children,
}: {
  title: ReactNode;
  description: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 data-step-title className="text-xl font-semibold tracking-tight outline-none">
          {title}
        </h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      {children}
    </div>
  );
}
