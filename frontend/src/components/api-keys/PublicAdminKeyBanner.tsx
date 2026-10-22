import Link from 'next/link';
import { useRouter } from 'next/router';
import { ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAppContext } from '@/lib/contexts/AppContext';
import { isPublicAdminKey } from '@/lib/public-admin-key';

const API_KEYS_PATH = '/api-keys';

/**
 * Warns while the session uses a public admin key. It has no dismiss button on
 * purpose: the warning goes away only when the operator signs in with another key.
 */
export function PublicAdminKeyBanner() {
  const { apiKey, capabilities } = useAppContext();
  const router = useRouter();
  if (!isPublicAdminKey(apiKey)) return null;

  return (
    // A landmark, not a live region: the layout remounts on every page, and a live
    // region would read the warning again on each navigation.
    <section
      aria-labelledby="public-admin-key-title"
      className="border-b border-destructive/30 bg-destructive/10 text-foreground"
    >
      <div className="mx-auto flex max-w-[1400px] flex-col gap-3 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
        <div className="flex gap-3">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
          <div className="space-y-1">
            <h2 id="public-admin-key-title" className="font-medium">
              You are signed in with a public admin key
            </h2>
            <p className="opacity-85">
              This key is in the Masumi source code, so anyone can use it. Use it only for a one-off
              or local setup. To replace it, create a new admin key, sign in with it, and then
              delete this key.
            </p>
          </div>
        </div>
        {capabilities.canAdmin && router.pathname !== API_KEYS_PATH && (
          <Button size="sm" variant="destructive" asChild>
            <Link href={API_KEYS_PATH}>Manage API keys</Link>
          </Button>
        )}
      </div>
    </section>
  );
}
