import { useEffect } from 'react';
import { useRouter } from 'next/router';

import { buildQuarantineRedirectTarget } from '@/lib/quarantine-redirect';

/** Legacy static-export route: /admin/sync-quarantine → /admin/tx-sync-quarantine */
export default function SyncQuarantineRedirectPage() {
  const router = useRouter();

  useEffect(() => {
    if (!router.isReady) return;
    void router.replace(buildQuarantineRedirectTarget(router.query));
  }, [router]);

  return null;
}
