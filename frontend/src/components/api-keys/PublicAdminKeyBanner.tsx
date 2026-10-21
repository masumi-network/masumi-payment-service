import Link from 'next/link';
import { ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAppContext } from '@/lib/contexts/AppContext';
import { isPublicAdminKey } from '@/lib/public-admin-key';

/**
 * Warns while the session uses a public admin key. It has no dismiss button on
 * purpose: the warning goes away only when the operator signs in with another key.
 */
export function PublicAdminKeyBanner() {
  const { apiKey } = useAppContext();
  if (!isPublicAdminKey(apiKey)) return null;

  return (
    <div role="alert" className="border-b border-destructive/30 bg-destructive/10 text-foreground">
      <div className="mx-auto flex max-w-[1400px] flex-col gap-3 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
        <div className="flex gap-3">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <div className="space-y-1">
            <span className="font-medium">You are signed in with a public admin key</span>
            <p className="opacity-85">
              This key is in the Masumi source code, so anyone can use it. Use it only for a one-off
              or local setup. To replace it, create a new admin key, sign in with it, and then
              delete this key.
            </p>
          </div>
        </div>
        <Button size="sm" variant="destructive" asChild>
          <Link href="/api-keys">Manage API keys</Link>
        </Button>
      </div>
    </div>
  );
}
