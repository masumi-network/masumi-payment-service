import type { ReactNode } from 'react';
import { Link2 } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Human-readable link text: host + path, without scheme. Falls back to raw url. */
export function formatMetadataLinkLabel(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === '/' ? '' : parsed.pathname;
    return `${parsed.host}${path}`;
  } catch {
    return url;
  }
}

export function MetadataFields({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <dl
      className={cn('divide-y divide-border/60 rounded-md border bg-muted/30 text-sm', className)}
    >
      {children}
    </dl>
  );
}

export function MetadataField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 px-3 py-2.5">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="min-w-0 leading-snug">{children}</dd>
    </div>
  );
}

export function MetadataPlainValue({ children }: { children: ReactNode }) {
  return <span className="break-words">{children}</span>;
}

export function MetadataLinkValue({
  href,
  label,
  showExternalIcon = true,
}: {
  href: string;
  label: string;
  showExternalIcon?: boolean;
}) {
  const isHttp = href.startsWith('http://') || href.startsWith('https://');

  return (
    <a
      href={href}
      {...(isHttp ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      className="inline-flex min-w-0 items-start gap-1 break-all text-primary hover:underline"
    >
      <span className="min-w-0 break-all">{label}</span>
      {showExternalIcon && isHttp ? <Link2 className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : null}
    </a>
  );
}
